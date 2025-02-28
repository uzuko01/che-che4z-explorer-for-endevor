/*
 * © 2022 Broadcom Inc and/or its subsidiaries; All rights reserved
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Broadcom, Inc. - initial API and implementation
 */

import {
  isFingerprintMismatchError,
  isSignoutError,
  stringifyWithHiddenCredential,
} from '@local/endevor/utils';
import {
  deleteFile,
  getFileContent,
  saveFileIntoWorkspaceFolder,
} from '@local/vscode-wrapper/workspace';
import { Uri } from 'vscode';
import {
  askForChangeControlValue,
  dialogCancelled as changeControlDialogCancelled,
} from '../dialogs/change-control/endevorChangeControlDialogs';
import {
  askForUploadLocation,
  dialogCancelled as uploadLocationDialogCancelled,
} from '../dialogs/locations/endevorUploadLocationDialogs';
import {
  overrideSignOutElement,
  signOutElement,
  updateElement,
} from '../endevor';
import { logger, reporter } from '../globals';
import { isError } from '../utils';
import {
  closeActiveTextEditor,
  withNotificationProgress,
} from '@local/vscode-wrapper/window';
import { fromEditedElementUri } from '../uri/editedElementUri';
import {
  ActionChangeControlValue,
  ChangeControlValue,
  Element,
  ElementMapPath,
  ElementSearchLocation,
  Service,
} from '@local/endevor/_doc/Endevor';
import { compareElementWithRemoteVersion } from './compareElementWithRemoteVersion';
import { TextDecoder } from 'util';
import { ENCODING } from '../constants';
import {
  askToOverrideSignOutForElements,
  askToSignOutElements,
} from '../dialogs/change-control/signOutDialogs';
import { turnOnAutomaticSignOut } from '../settings/settings';
import * as path from 'path';
import { Action, Actions } from '../_doc/Actions';
import { ElementLocationName, EndevorServiceName } from '../_doc/settings';
import {
  UploadElementCommandCompletedStatus,
  TelemetryEvents,
  SignoutErrorRecoverCommandCompletedStatus,
} from '../_doc/Telemetry';
import { showElementToEdit } from './edit/common';

export const uploadElementCommand = async (
  dispatch: (action: Action) => Promise<void>,
  elementUri: Uri
): Promise<void> => {
  reporter.sendTelemetryEvent({
    type: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
  });
  const editSessionParams = fromEditedElementUri(elementUri);
  if (isError(editSessionParams)) {
    const error = editSessionParams;
    logger.error(
      `Unable to upload the selected element to Endevor.`,
      `Unable to upload the selected element to Endevor because parsing of the element's URI failed with error ${error.message}.`
    );
    return;
  }
  logger.trace(
    `Upload the element command was called for ${stringifyWithHiddenCredential({
      query: JSON.parse(decodeURIComponent(elementUri.query)),
      path: elementUri.fsPath,
    })}.`
  );
  const {
    element,
    searchLocation,
    service,
    fingerprint,
    searchLocationName,
    serviceName,
  } = editSessionParams;
  const uploadValues = await askForUploadValues(searchLocation, element);
  if (isError(uploadValues)) {
    const error = uploadValues;
    logger.error(`${error.message}.`);
    return;
  }
  const [uploadLocation, uploadChangeControlValue] = uploadValues;
  await closeEditSession(elementUri);
  const uploadResult = await uploadElement(dispatch)(
    service,
    searchLocation,
    serviceName,
    searchLocationName
  )({
    ...uploadLocation,
    extension: element.extension,
  })(uploadChangeControlValue)(elementUri.fsPath, fingerprint);
  if (isError(uploadResult)) {
    const error = uploadResult;
    logger.error(
      `Unable to upload the element ${element.name} to Endevor.`,
      `${error.message}.`
    );
    const reopenResult = await reopenEditSession(elementUri);
    if (isError(reopenResult)) {
      logger.trace(`${error.message}.`);
    }
    return;
  }
  await safeRemoveUploadedElement(elementUri);
  await updateTreeAfterSuccessfulUpload(dispatch)(
    serviceName,
    service,
    searchLocationName,
    searchLocation,
    [element]
  );
  reporter.sendTelemetryEvent({
    type: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_COMPLETED,
    status: UploadElementCommandCompletedStatus.SUCCESS,
  });
};

const askForUploadValues = async (
  searchLocation: ElementSearchLocation,
  element: Element
): Promise<[ElementMapPath, ActionChangeControlValue] | Error> => {
  const uploadType = searchLocation.type ? searchLocation.type : element.type;
  const uploadLocation = await askForUploadLocation({
    environment: searchLocation.environment,
    stageNumber: searchLocation.stageNumber,
    system: searchLocation.system,
    subsystem: searchLocation.subsystem,
    type: uploadType,
    element: element.name,
    instance: element.instance,
  });
  if (uploadLocationDialogCancelled(uploadLocation)) {
    return new Error(
      `Upload location must be specified to upload the element ${element.name}`
    );
  }
  const uploadChangeControlValue = await askForChangeControlValue({
    ccid: searchLocation.ccid,
    comment: searchLocation.comment,
  });
  if (changeControlDialogCancelled(uploadChangeControlValue)) {
    return new Error(
      `CCID and Comment must be specified to upload the element ${uploadLocation.name}`
    );
  }
  return [uploadLocation, uploadChangeControlValue];
};

const uploadElement =
  (dispatch: (action: Action) => Promise<void>) =>
  (
    service: Service,
    searchLocation: ElementSearchLocation,
    serviceName: EndevorServiceName,
    searchLocationName: ElementLocationName
  ) =>
  (element: Element) =>
  (uploadChangeControlValue: ChangeControlValue) =>
  async (
    elementFilePath: string,
    fingerprint: string
  ): Promise<void | Error> => {
    const content = await readEditedElementContent(elementFilePath);
    if (isError(content)) {
      const error = content;
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.ERROR,
        errorContext: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
        status: UploadElementCommandCompletedStatus.GENERIC_ERROR,
        error,
      });
      return error;
    }
    const uploadResult = await withNotificationProgress(
      `Uploading the element ${element.name}...`
    )((progressReporter) => {
      return updateElement(progressReporter)(service)(element)(
        uploadChangeControlValue
      )({
        fingerprint,
        content,
      });
    });
    if (isSignoutError(uploadResult)) {
      logger.warn(
        `The element ${element.name} requires a sign out action to update/add elements.`
      );
      const signoutResult = await complexSignoutElement(dispatch)(
        service,
        searchLocation,
        serviceName,
        searchLocationName
      )(element)(uploadChangeControlValue);
      if (isError(signoutResult)) {
        const error = signoutResult;
        reporter.sendTelemetryEvent({
          type: TelemetryEvents.ERROR,
          errorContext: TelemetryEvents.COMMAND_SIGNOUT_ERROR_RECOVER_CALLED,
          status: SignoutErrorRecoverCommandCompletedStatus.GENERIC_ERROR,
          error,
        });
        return error;
      }
      return uploadElement(dispatch)(
        service,
        searchLocation,
        serviceName,
        searchLocationName
      )(element)(uploadChangeControlValue)(elementFilePath, fingerprint);
    }
    if (isFingerprintMismatchError(uploadResult)) {
      logger.warn(
        `There is a conflict with the remote copy of element ${element.name}. Please resolve it before uploading again.`
      );
      const savedLocalElementVersionUri = await saveLocalElementVersion(
        elementFilePath
      )(element)(content);
      if (isError(savedLocalElementVersionUri)) {
        const error = new Error(
          `Unable to save a local version of the element ${element.name} to compare because of error ${savedLocalElementVersionUri.message}`
        );
        reporter.sendTelemetryEvent({
          type: TelemetryEvents.ERROR,
          errorContext: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
          status: UploadElementCommandCompletedStatus.GENERIC_ERROR,
          error,
        });
        return error;
      }
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.COMMAND_RESOLVE_CONFLICT_WITH_REMOTE_CALL,
        context: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_COMPLETED,
      });
      const showCompareDialogResult = await compareElementWithRemoteVersion(
        service,
        searchLocation
      )(uploadChangeControlValue)(
        element,
        serviceName,
        searchLocationName
      )(savedLocalElementVersionUri.fsPath);
      if (isError(showCompareDialogResult)) {
        const error = showCompareDialogResult;
        reporter.sendTelemetryEvent({
          type: TelemetryEvents.ERROR,
          errorContext: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
          status: UploadElementCommandCompletedStatus.GENERIC_ERROR,
          error,
        });
        return error;
      }
      return;
    }
    if (isError(uploadResult)) {
      const error = uploadResult;
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.ERROR,
        errorContext: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
        status: UploadElementCommandCompletedStatus.GENERIC_ERROR,
        error,
      });
    }
    return uploadResult;
  };

const readEditedElementContent = async (
  elementTempFilePath: string
): Promise<string | Error> => {
  try {
    return new TextDecoder(ENCODING).decode(
      await getFileContent(Uri.file(elementTempFilePath))
    );
  } catch (error) {
    return new Error(
      `Unable to read the element content because of error ${error.message}`
    );
  }
};

const complexSignoutElement =
  (dispatch: (action: Action) => Promise<void>) =>
  (
    service: Service,
    searchLocation: ElementSearchLocation,
    serviceName: EndevorServiceName,
    searchLocationName: ElementLocationName
  ) =>
  (element: Element) =>
  async (
    signoutChangeControlValue: ActionChangeControlValue
  ): Promise<void | Error> => {
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.COMMAND_SIGNOUT_ERROR_RECOVER_CALLED,
      context: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
    });
    const signOut = await askToSignOutElements([element.name]);
    if (!signOut.signOutElements && !signOut.automaticSignOut) {
      const error = new Error(
        `Unable to upload the element ${element.name} because it is signed out to somebody else`
      );
      return error;
    }
    if (signOut.automaticSignOut) {
      try {
        await turnOnAutomaticSignOut();
      } catch (e) {
        logger.warn(
          `Unable to update the global sign out setting.`,
          `Unable to update the global sign out setting because of error ${e.message}.`
        );
      }
    }
    const signOutResult = await withNotificationProgress(
      `Signing out the element ${element.name}...`
    )((progressReporter) =>
      signOutElement(progressReporter)(service)(element)(
        signoutChangeControlValue
      )
    );
    if (isSignoutError(signOutResult)) {
      logger.warn(
        `Unable to sign out the element ${element.name} because it is signed out to somebody else.`
      );
      const overrideSignout = await askToOverrideSignOutForElements([
        element.name,
      ]);
      if (!overrideSignout) {
        return new Error(
          `The element ${element.name} is signed out to somebody else, override signout action is not selected`
        );
      }
      const overrideSignoutResult = await withNotificationProgress(
        `Signing out the element ${element.name}...`
      )((progressReporter) =>
        overrideSignOutElement(progressReporter)(service)(element)(
          signoutChangeControlValue
        )
      );
      if (isError(overrideSignoutResult)) {
        const error = signOutResult;
        return new Error(
          `Unable to perform an override signout of the element ${element.name} because of error ${error.message}`
        );
      }
      await updateTreeAfterSuccessfulSignout(dispatch)(
        serviceName,
        service,
        searchLocationName,
        searchLocation,
        [element]
      );
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.COMMAND_SIGNOUT_ERROR_RECOVER_COMPLETED,
        context: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
        status: SignoutErrorRecoverCommandCompletedStatus.OVERRIDE_SUCCESS,
      });
      return overrideSignoutResult;
    }
    if (isError(signOutResult)) {
      const error = signOutResult;
      return new Error(
        `Unable to sign out the element ${element.name} because of error ${error.message}`
      );
    }
    await updateTreeAfterSuccessfulSignout(dispatch)(
      serviceName,
      service,
      searchLocationName,
      searchLocation,
      [element]
    );
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.COMMAND_SIGNOUT_ERROR_RECOVER_COMPLETED,
      context: TelemetryEvents.COMMAND_UPLOAD_ELEMENT_CALLED,
      status: SignoutErrorRecoverCommandCompletedStatus.SIGNOUT_SUCCESS,
    });
  };

const saveLocalElementVersion =
  (elementFilePath: string) =>
  (element: Element) =>
  async (content: string): Promise<Uri | Error> => {
    const tempEditFolder = path.dirname(elementFilePath);
    if (!tempEditFolder) {
      return new Error(
        'Unable to get a valid edit folder name to compare the elements'
      );
    }

    const tempEditFolderUri = Uri.file(tempEditFolder);
    try {
      return saveFileIntoWorkspaceFolder(tempEditFolderUri)(
        {
          fileName: `${element.name}-local-version`,
          fileExtension: element.extension,
        },
        content
      );
    } catch (e) {
      return e;
    }
  };

const closeEditSession = async (_editedFileUri: Uri) => {
  await closeActiveTextEditor();
};

const reopenEditSession = (editedElementUri: Uri) => {
  return showElementToEdit(editedElementUri);
};

const safeRemoveUploadedElement = async (editedElementUri: Uri) => {
  try {
    await deleteFile(editedElementUri);
  } catch (e) {
    logger.error(
      `Unable to remove the file ${editedElementUri.fsPath}.`,
      `Unable to remove the file ${editedElementUri.fsPath} because of error ${e.message}.`
    );
  }
};

const updateTreeAfterSuccessfulSignout =
  (dispatch: (action: Action) => Promise<void>) =>
  async (
    serviceName: EndevorServiceName,
    service: Service,
    searchLocationName: ElementLocationName,
    searchLocation: ElementSearchLocation,
    elements: ReadonlyArray<Element>
  ): Promise<void> => {
    await dispatch({
      type: Actions.ELEMENT_SIGNEDOUT,
      serviceName,
      service,
      searchLocationName,
      searchLocation,
      elements,
    });
  };

const updateTreeAfterSuccessfulUpload =
  (dispatch: (action: Action) => Promise<void>) =>
  async (
    serviceName: EndevorServiceName,
    service: Service,
    searchLocationName: ElementLocationName,
    searchLocation: ElementSearchLocation,
    elements: ReadonlyArray<Element>
  ): Promise<void> => {
    await dispatch({
      type: Actions.ELEMENT_UPDATED,
      serviceName,
      service,
      searchLocationName,
      searchLocation,
      elements,
    });
  };
