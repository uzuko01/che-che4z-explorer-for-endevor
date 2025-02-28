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

import { toSeveralTasksProgress } from '@local/endevor/utils';
import { withNotificationProgress } from '@local/vscode-wrapper/window';
import { getWorkspaceUri } from '@local/vscode-wrapper/workspace';
import { PromisePool } from 'promise-pool-tool';
import * as vscode from 'vscode';
import { MAX_PARALLEL_REQUESTS_DEFAULT } from '../../constants';
import { retrieveElementWithFingerprint } from '../../endevor';
import { logger, reporter } from '../../globals';
import { getMaxParallelRequests } from '../../settings/settings';
import { fromTreeElementUri } from '../../uri/treeElementUri';
import { isDefined, isError } from '../../utils';
import {
  TreeElementCommandArguments,
  EditElementCommandCompletedStatus,
  TelemetryEvents,
} from '../../_doc/Telemetry';
import {
  saveIntoEditFolder,
  withUploadOptions,
  showElementToEdit,
} from './common';

export const editSingleElement = async (
  element: Readonly<{
    name: string;
    uri: vscode.Uri;
  }>
): Promise<void> => {
  reporter.sendTelemetryEvent({
    type: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
    commandArguments: {
      type: TreeElementCommandArguments.SINGLE_ELEMENT,
    },
    autoSignOut: false,
  });
  const workspaceUri = await getWorkspaceUri();
  if (!workspaceUri) {
    const error = new Error(
      'At least one workspace in this project should be opened to edit elements'
    );
    logger.error(`${error.message}.`);
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.ERROR,
      errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
      status: EditElementCommandCompletedStatus.NO_OPENED_WORKSPACE_ERROR,
      error,
    });
    return;
  }
  const elementUri = fromTreeElementUri(element.uri);
  if (isError(elementUri)) {
    const error = elementUri;
    logger.error(
      `Unable to edit the element ${element.name}.`,
      `Unable to edit the element ${element.name} because of error ${error.message}.`
    );
    return;
  }
  const retrieveResult = await withNotificationProgress(
    `Retrieving element: ${element.name}`
  )(async (progressReporter) => {
    return retrieveElementWithFingerprint(progressReporter)(elementUri.service)(
      elementUri.element
    )();
  });
  if (isError(retrieveResult)) {
    const error = retrieveResult;
    logger.error(
      `Unable to retrieve the element ${element.name}.`,
      `${error.message}.`
    );
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.ERROR,
      errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
      status: EditElementCommandCompletedStatus.GENERIC_ERROR,
      error,
    });
    return;
  }
  const saveResult = await saveIntoEditFolder(workspaceUri)(
    elementUri.serviceName,
    elementUri.searchLocationName
  )(elementUri.element, retrieveResult.content);
  if (isError(saveResult)) {
    const error = saveResult;
    logger.error(
      `Unable to save the element ${element.name} into the file system.`,
      `${error.message}.`
    );
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.ERROR,
      errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
      status: EditElementCommandCompletedStatus.GENERIC_ERROR,
      error,
    });
    return;
  }
  const uploadableElementUri = withUploadOptions(saveResult)({
    ...elementUri,
    fingerprint: retrieveResult.fingerprint,
  });
  if (!uploadableElementUri) return;
  const showResult = await showElementToEdit(uploadableElementUri);
  if (isError(showResult)) {
    const error = showResult;
    logger.error(
      `Unable to open the element ${element.name} for editing.`,
      `${error.message}.`
    );
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.ERROR,
      errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
      status: EditElementCommandCompletedStatus.GENERIC_ERROR,
      error,
    });
    return;
  }
  reporter.sendTelemetryEvent({
    type: TelemetryEvents.COMMAND_EDIT_ELEMENT_COMPLETED,
    status: EditElementCommandCompletedStatus.SUCCESS,
  });
};

// TODO: think about pipe implementation or something like this
export const editMultipleElements = async (
  elements: ReadonlyArray<{
    name: string;
    uri: vscode.Uri;
  }>
): Promise<void> => {
  reporter.sendTelemetryEvent({
    type: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
    commandArguments: {
      type: TreeElementCommandArguments.MULTIPLE_ELEMENTS,
      elementsAmount: elements.length,
    },
    autoSignOut: false,
  });
  const workspaceUri = await getWorkspaceUri();
  if (!workspaceUri) {
    const error = new Error(
      'At least one workspace in this project should be opened to edit elements'
    );
    logger.error(`${error.message}.`);
    reporter.sendTelemetryEvent({
      type: TelemetryEvents.ERROR,
      errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
      status: EditElementCommandCompletedStatus.NO_OPENED_WORKSPACE_ERROR,
      error,
    });
    return;
  }
  let endevorMaxRequestsNumber: number;
  try {
    endevorMaxRequestsNumber = getMaxParallelRequests();
  } catch (e) {
    logger.warn(
      `Cannot read settings value for endevor pool size, the default ${MAX_PARALLEL_REQUESTS_DEFAULT} will be used instead.`,
      `Reading settings error ${e.message}.`
    );
    endevorMaxRequestsNumber = MAX_PARALLEL_REQUESTS_DEFAULT;
  }
  const elementUris = elements.map((element) => {
    const elementsUploadOptions = fromTreeElementUri(element.uri);
    if (isError(elementsUploadOptions)) {
      const error = elementsUploadOptions;
      return new Error(
        `Unable to edit the element ${element.name} because of an error ${error.message}`
      );
    }
    return elementsUploadOptions;
  });
  const elementsNumber = elements.length;
  const retrievedContents = await withNotificationProgress(
    `Retrieving elements: ${elements.map((element) => element.name).join(', ')}`
  )((progressReporter) => {
    return new PromisePool(
      elementUris.map((element) => {
        if (isError(element)) {
          const error = element;
          return () => Promise.resolve(error);
        }
        return async () =>
          retrieveElementWithFingerprint(
            toSeveralTasksProgress(progressReporter)(elementsNumber)
          )(element.service)(element.element)();
      }),
      {
        concurrency: endevorMaxRequestsNumber,
      }
    ).start();
  });
  const retrieveResults = elementUris.map((elementUri, index) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const retrievedContent = retrievedContents[index]!;
    if (isError(elementUri)) {
      const error = elementUri;
      return error;
    }
    if (isError(retrievedContent)) {
      const error = retrievedContent;
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.ERROR,
        errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
        status: EditElementCommandCompletedStatus.GENERIC_ERROR,
        error,
      });
      return error;
    }
    return {
      element: elementUri,
      content: retrievedContent,
    };
  });
  const saveResults = await Promise.all(
    retrieveResults.map(async (result) => {
      if (isError(result)) {
        const error = result;
        return error;
      }
      const saveResult = await saveIntoEditFolder(workspaceUri)(
        result.element.serviceName,
        result.element.searchLocationName
      )(result.element.element, result.content.content);
      if (isError(saveResult)) {
        const error = saveResult;
        reporter.sendTelemetryEvent({
          type: TelemetryEvents.ERROR,
          errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
          status: EditElementCommandCompletedStatus.GENERIC_ERROR,
          error,
        });
        return error;
      }
      return withUploadOptions(saveResult)({
        ...result.element,
        fingerprint: result.content.fingerprint,
        serviceName: result.element.serviceName,
        searchLocationName: result.element.searchLocationName,
      });
    })
  );
  // show text editors only in sequential order (concurrency: 1)
  const sequentialShowing = 1;
  const showResults = await new PromisePool(
    saveResults.map((saveResult) => {
      if (!isError(saveResult) && saveResult) {
        const savedElementUri = saveResult;
        return async () => {
          const showResult = await showElementToEdit(savedElementUri);
          if (isError(showResult)) {
            const error = showResult;
            reporter.sendTelemetryEvent({
              type: TelemetryEvents.ERROR,
              errorContext: TelemetryEvents.COMMAND_EDIT_ELEMENT_CALLED,
              status: EditElementCommandCompletedStatus.GENERIC_ERROR,
              error,
            });
            return Promise.resolve(error);
          }
          return Promise.resolve(showResult);
        };
      }
      const error = saveResult;
      return () => Promise.resolve(error);
    }),
    {
      concurrency: sequentialShowing,
    }
  ).start();
  const overallErrors = showResults
    .map((value) => {
      if (isError(value)) return value;
      reporter.sendTelemetryEvent({
        type: TelemetryEvents.COMMAND_EDIT_ELEMENT_COMPLETED,
        status: EditElementCommandCompletedStatus.SUCCESS,
      });
      return undefined;
    })
    .filter(isDefined);
  if (overallErrors.length) {
    const elementNames = elements.map((element) => element.name).join(', ');
    logger.error(
      `There were some issues during editing of the elements ${elementNames}.`,
      `There were some issues during editing of the elements ${elementNames}: ${[
        '',
        ...overallErrors.map((error) => error.message),
      ].join('\n')}.`
    );
  }
};
