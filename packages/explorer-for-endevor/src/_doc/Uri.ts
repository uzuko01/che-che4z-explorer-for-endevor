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

// TODO: rewrite with io-ts types
import {
  ChangeControlValue,
  Element,
  ElementSearchLocation,
  Service,
} from '@local/endevor/_doc/Endevor';
import { ElementLocationName, EndevorServiceName } from './settings';

export const enum Schemas {
  TREE_ELEMENT = 'e4eElement',
  ELEMENT_LISTING = 'e4eListing',
  FILE = 'file',
  READ_ONLY_FILE = 'e4eReadonlyFile',
}

export const enum QueryTypes {
  EDITED_ELEMENT = 'edited-element',
  COMPARED_ELEMENT = 'compared-element',
}

export const enum Extensions {
  TREE_ELEMENT = 'prnt',
  ELEMENT_LISTING = 'lst',
}

export type TreeElementUriQuery = Readonly<{
  serviceName: EndevorServiceName;
  searchLocationName: ElementLocationName;
  service: Service;
  element: Element;
  searchLocation: ElementSearchLocation;
}>;

export type EditedElementUriQuery = Readonly<{
  serviceName: EndevorServiceName;
  searchLocationName: ElementLocationName;
  service: Service;
  element: Element;
  searchLocation: ElementSearchLocation;
  fingerprint: string;
}>;

export type ComparedElementUriQuery = Readonly<{
  serviceName: EndevorServiceName;
  searchLocationName: ElementLocationName;
  service: Service;
  searchLocation: ElementSearchLocation;
  element: Element;
  fingerprint: string;
  uploadChangeControlValue: ChangeControlValue;
  remoteVersionTempFilePath: string;
}>;

export type ElementListingUriQuery = Readonly<{
  service: Service;
  element: Element;
}>;
