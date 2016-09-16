/// <reference path="../../definitions/node.d.ts" />
/// <reference path="../../definitions/q.d.ts" />
/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import tl = require('vsts-task-lib/task');
import path = require('path');
import fs = require('fs');

var azureRmUtil = require ('./AzureRMUtil.js');
var msDeployUtility = require('./MSDeployUtility.js');
var kuduUtility = require('./KuduUtility.js');

async function run() {
    try {

        tl.setResourcePath(path.join( __dirname, 'task.json'));
        var connectedServiceName = tl.getInput('ConnectedServiceName', true);
        var webAppName: string = tl.getInput('WebAppName', true);
        var deployToSlotFlag: boolean = tl.getBoolInput('DeployToSlotFlag', false);
        var resourceGroupName: string = tl.getInput('ResourceGroupName', false);
        var slotName: string = tl.getInput('SlotName', false);
        var webDeployPkg: string = tl.getPathInput('Package', true);
        var virtualApplication: string = tl.getInput('VirtualApplication', false);
        var isTaskUpgraded: boolean = isTaskUpgradeDone(tl.getInput('UseWebDeploy', false));

        var setParametersFile: string = isTaskUpgraded ? tl.getPathInput('SetParametersFile1', false) : tl.getPathInput('SetParametersFile', false);
        var removeAdditionalFilesFlag: boolean = isTaskUpgraded ? tl.getBoolInput('RemoveAdditionalFilesFlag1', false) : tl.getBoolInput('RemoveAdditionalFilesFlag', false);
        var excludeFilesFromAppDataFlag: boolean = isTaskUpgraded ? tl.getBoolInput('ExcludeFilesFromAppDataFlag1', false) : tl.getBoolInput('ExcludeFilesFromAppDataFlag', false);
        var takeAppOfflineFlag: boolean = isTaskUpgraded ? tl.getBoolInput('TakeAppOfflineFlag1', false) : tl.getBoolInput('TakeAppOfflineFlag', false);
        var additionalArguments: string = isTaskUpgraded ? tl.getInput('AdditionalArguments1', false) : tl.getInput('AdditionalArguments', false);

        var useWebDeploy: boolean = isTaskUpgraded ? tl.getBoolInput('UseWebDeploy', false) : true;
        tl.debug('useWebDeploy = ' + useWebDeploy);

        var webAppUri:string = tl.getInput('WebAppUri', false);
        var endPointAuthCreds = tl.getEndpointAuthorization(connectedServiceName, true);

        var SPN = new Array();
        SPN["servicePrincipalClientID"] = endPointAuthCreds.parameters["serviceprincipalid"];
        SPN["servicePrincipalKey"] = endPointAuthCreds.parameters["serviceprincipalkey"];
        SPN["tenantID"] = endPointAuthCreds.parameters["tenantid"];
        SPN["subscriptionId"] = tl.getEndpointDataParameter(connectedServiceName, 'subscriptionid', true);

        var isFolderBasedDeployment = await isInputPkgIsFolder(webDeployPkg);
        var publishingProfile = await azureRmUtil.getAzureRMWebAppPublishProfile(SPN, webAppName, resourceGroupName, deployToSlotFlag, slotName);
        tl._writeLine(tl.loc('GotconnectiondetailsforazureRMWebApp0', webAppName));

        if(virtualApplication) {
            publishingProfile.destinationAppUrl += "/" + virtualApplication;
        }

        if(webAppUri) {
            tl.setVariable(webAppUri, publishingProfile.destinationAppUrl);
        }

        if(canUseWebDeploy(useWebDeploy)) {        
           tl._writeLine("##vso[task.setvariable variable=websitePassword;issecret=true;]" + publishingProfile.userPWD);
            await DeployUsingMSDeploy(webDeployPkg, webAppName, publishingProfile, removeAdditionalFilesFlag,
                            excludeFilesFromAppDataFlag, takeAppOfflineFlag, virtualApplication, setParametersFile,
                            additionalArguments, isFolderBasedDeployment, useWebDeploy);
        } else {
            tl.debug(tl.loc("Initiateddeploymentviakuduserviceforwebapppackage", webDeployPkg));
            var azureWebAppDetails = await azureRmUtil.getAzureRMWebAppConfigDetails(SPN, webAppName, resourceGroupName, deployToSlotFlag, slotName);
            await DeployUsingKuduDeploy(webDeployPkg, azureWebAppDetails, publishingProfile, virtualApplication, isFolderBasedDeployment);
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, error);
    }
}

/**
 * Executes Web Deploy command
 * 
 * @param   webDeployPkg                   Web deploy package
 * @param   webAppName                      web App Name
 * @param   publishingProfile               Azure RM Connection Details
 * @param   removeAdditionalFilesFlag       Flag to set DoNotDeleteRule rule
 * @param   excludeFilesFromAppDataFlag     Flag to prevent App Data from publishing
 * @param   takeAppOfflineFlag              Flag to enable AppOffline rule
 * @param   virtualApplication              Virtual Application Name
 * @param   setParametersFile               Set Parameter File path
 * @param   additionalArguments             Arguments provided by user
 * 
 */
async function DeployUsingMSDeploy(webDeployPkg, webAppName, publishingProfile, removeAdditionalFilesFlag, 
        excludeFilesFromAppDataFlag, takeAppOfflineFlag, virtualApplication, setParametersFile, additionalArguments, isFolderBasedDeployment, useWebDeploy) {

    var isParamFilePresentInPackage = isFolderBasedDeployment ? false : await msDeployUtility.containsParamFile(webDeployPkg);
    setParametersFile = getSetParamFilePath(setParametersFile);
    var msDeployPath = await msDeployUtility.getMSDeployFullPath();
    var msDeployCmdArgs = msDeployUtility.getMSDeployCmdArgs(webDeployPkg, webAppName, publishingProfile, removeAdditionalFilesFlag,
        excludeFilesFromAppDataFlag, takeAppOfflineFlag, virtualApplication, setParametersFile, additionalArguments, isParamFilePresentInPackage, isFolderBasedDeployment, useWebDeploy);

    var isDeploymentSuccess = true;
    var deploymentError = null;
    try {

        var msDeployBatchFile = tl.getVariable('System.DefaultWorkingDirectory') + '\\' + 'msDeployCommand.bat';
        var silentCommand = '@echo off \n';
        var msDeployCommand = '"' + msDeployPath + '" ' + msDeployCmdArgs;
        var batchCommand = silentCommand + msDeployCommand;

        tl.writeFile(msDeployBatchFile, batchCommand);
        tl._writeLine(tl.loc("Runningcommand", msDeployCommand));
        await tl.exec("cmd", ['/C', msDeployBatchFile], <any> {failOnStdErr: true});
        tl._writeLine(tl.loc('WebappsuccessfullypublishedatUrl0', publishingProfile.destinationAppUrl));
    }
    catch(error) {
        tl.error(tl.loc('Failedtodeploywebsite'));
        isDeploymentSuccess = false;
        deploymentError = error;
    }

    try {
        tl._writeLine(await azureRmUtil.updateDeploymentStatus(publishingProfile, isDeploymentSuccess));
    }
    catch(error) {
        tl.warning(error);
    }
    finally {
        if(!isDeploymentSuccess) {
            throw Error(deploymentError);
        }
    }
}

/**
 * Deploys website using Kudu REST API
 * 
 * @param   webDeployPkg                   Web deploy package
 * @param   webAppName                     Web App Name
 * @param   publishingProfile              Azure RM Connection Details
 * @param   virtualApplication             Virtual Application Name
 * @param   isFolderBasedDeployment        Input is folder or not
 *
 */
async function DeployUsingKuduDeploy(webDeployPkg, azureWebAppDetails, publishingProfile, virtualApplication, isFolderBasedDeployment) {

    var isDeploymentSuccess = true;
    var deploymentError = null;

    try {
        var virtualApplicationMappings = azureWebAppDetails.properties.virtualApplications;
        var webAppZipFile = webDeployPkg;
        if(isFolderBasedDeployment) {
            webAppZipFile = await kuduUtility.archiveFolder(webDeployPkg);
            tl.debug(tl.loc("Compressedfolderintozip", webDeployPkg, webAppZipFile));
        } else {
            if (await kuduUtility.containsParamFile(webAppZipFile)) {
                throw new Error(tl.loc("MSDeploygeneratedpackageareonlysupportedforWindowsplatform")); 
            }
        }
        var pathMappings = kuduUtility.getVirtualAndPhysicalPaths(virtualApplication, virtualApplicationMappings);
        await kuduUtility.deployWebAppPackage(webAppZipFile, publishingProfile, pathMappings[0], pathMappings[1]);
        tl._writeLine(tl.loc('WebappsuccessfullypublishedatUrl0', publishingProfile.destinationAppUrl));
    }
    catch(error) {
        tl.error(tl.loc('Failedtodeploywebsite'));
        isDeploymentSuccess = false;
        deploymentError = error;
    }

    try {
        tl._writeLine(await azureRmUtil.updateDeploymentStatus(publishingProfile, isDeploymentSuccess));
    }
    catch(error) {
        tl.warning(error);
    }
    finally {
        if(!isDeploymentSuccess) {
            throw Error(deploymentError);
        }
    }
}

/**
 * Takes useWebDeploy as input and returns it is edited or not.
 * 
 * @param useWebDeploy value of from task.json
 */
function isTaskUpgradeDone(useWebDeploy: string): boolean {
    return useWebDeploy !== "( SetParametersFile != \"\" || RemoveAdditionalFilesFlag == true || ExcludeFilesFromAppDataFlag == true || TakeAppOfflineFlag == true || AdditionalArguments != \"\") ? true : false";
}

/**
 * Validates the input package and finds out input type
 * 
 * @param webDeployPkg Web Deploy Package input
 * 
 * @return true/false based on input package type.
 */
async function isInputPkgIsFolder(webDeployPkg: string) {
    if (!tl.exist(webDeployPkg)) {
        throw new Error(tl.loc('Invalidwebapppackageorfolderpathprovided', webDeployPkg));
    }

    return !fileExists(webDeployPkg);
}

/**
 * Checks whether the given path is file or not.
 * @param path input file path
 * 
 * @return true/false based on input is file or not.

 */
function fileExists(path): boolean {
  try  {
    return tl.stats(path).isFile();
  }
  catch(error) {
    if(error.code == 'ENOENT') {
      return false;
    }
    tl.debug("Exception tl.stats (" + path + "): " + error);
    throw Error(error);
  }
}

/**
 * Validates whether input for path and returns right path.
 * 
 * @param path input
 * 
 * @returns null when input is empty, otherwise returns same path.
 */
function getSetParamFilePath(setParametersFile: string) : string {

    if(!tl.filePathSupplied('SetParametersFile')) {
        setParametersFile = null;
    }
    else if (!fileExists(setParametersFile)) {
        throw Error(tl.loc('SetParamFilenotfound0', setParametersFile));
    }

    return setParametersFile;
}

/**
 * Checks if WebDeploy should be used to deploy webapp package or folder
 * 
 * @param useWebDeploy if user explicitly checked useWebDeploy
 */
function canUseWebDeploy(useWebDeploy: boolean) {
    var win = tl.osType().match(/^Win/);
    return (useWebDeploy || win);
}

run();