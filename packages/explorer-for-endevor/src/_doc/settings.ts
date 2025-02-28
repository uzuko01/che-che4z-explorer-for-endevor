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

export type EndevorServiceName = string;
export type ElementLocationName = string;

export type LocationConfig = Readonly<{
  service: EndevorServiceName;
  elementLocations: ReadonlyArray<ElementLocationName>;
}>;
