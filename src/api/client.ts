/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PagerDutyApi,
  PagerDutyTriggerAlarmRequest,
  PagerDutyClientApiDependencies,
  PagerDutyClientApiConfig,
  RequestOptions,
} from './types';
import { PagerDutyChangeEventsResponse, 
  PagerDutyOnCallUsersResponse, 
  PagerDutyUser, 
  PagerDutyServiceResponse,
  PagerDutyIncidentsResponse 
} from '@pagerduty/backstage-plugin-common';
import { createApiRef, ConfigApi } from '@backstage/core-plugin-api';
import { NotFoundError } from '@backstage/errors';
import { Entity } from '@backstage/catalog-model';
import { getPagerDutyEntity } from '../components/pagerDutyEntity';
import { PagerDutyEntity } from '../types';

/** @public */
export class UnauthorizedError extends Error {}

/** @public */
export class ForbiddenError extends Error { }

/** @public */
export const pagerDutyApiRef = createApiRef<PagerDutyApi>({
  id: 'plugin.pagerduty.api',
});

/** @public */
export class PagerDutyClient implements PagerDutyApi {
  static fromConfig(
    configApi: ConfigApi,
    dependencies: PagerDutyClientApiDependencies,
  ) {
    const { discoveryApi, fetchApi } = dependencies;

    const eventsBaseUrl: string =
      configApi.getOptionalString('pagerDuty.eventsBaseUrl') ??
      'https://events.pagerduty.com/v2';

    return new PagerDutyClient({
      eventsBaseUrl,
      discoveryApi,
      fetchApi,
    });
  }

  constructor(private readonly config: PagerDutyClientApiConfig) {}

  async getServiceByPagerDutyEntity(
    pagerDutyEntity: PagerDutyEntity,
  ): Promise<PagerDutyServiceResponse> {
    const { integrationKey, serviceId } = pagerDutyEntity;

    let response: PagerDutyServiceResponse;
    let url: string;

    if (integrationKey) {
      url = `${await this.config.discoveryApi.getBaseUrl(
        'pagerduty',
      )}/services?integration_key=${integrationKey}`;
      const serviceResponse = await this.findByUrl<PagerDutyServiceResponse>(url);

      if (serviceResponse.service === undefined) throw new NotFoundError();

      response = serviceResponse;
    } else if (serviceId) {
      url = `${await this.config.discoveryApi.getBaseUrl(
        'pagerduty',
      )}/services/${serviceId}`;

      response = await this.findByUrl<PagerDutyServiceResponse>(url);
    } else {
      throw new NotFoundError();
    }

    return response;
  }

  async getServiceByEntity(entity: Entity): Promise<PagerDutyServiceResponse> {
    return await this.getServiceByPagerDutyEntity(getPagerDutyEntity(entity));
  }
  async getIncidentsByServiceId(
    serviceId: string,
  ): Promise<PagerDutyIncidentsResponse> {
    const url = `${await this.config.discoveryApi.getBaseUrl(
      'pagerduty',
    )}/services/${serviceId}/incidents`;

    return await this.findByUrl<PagerDutyIncidentsResponse>(url);
  }

  async getChangeEventsByServiceId(
    serviceId: string,
  ): Promise<PagerDutyChangeEventsResponse> {
    const url = `${await this.config.discoveryApi.getBaseUrl(
      'pagerduty',
    )}/services/${serviceId}/change-events`;

    return await this.findByUrl<PagerDutyChangeEventsResponse>(url);
  }

  async getOnCallByPolicyId(
    policyId: string,
  ): Promise<PagerDutyUser[]> {
    const params = `escalation_policy_ids[]=${policyId}`;
    const url = `${await this.config.discoveryApi.getBaseUrl(
      'pagerduty',
    )}/oncall-users?${params}`;

    const response: PagerDutyOnCallUsersResponse = await this.findByUrl<PagerDutyOnCallUsersResponse>(url);
    return response.users;
  }

  triggerAlarm(request: PagerDutyTriggerAlarmRequest): Promise<Response> {
    const { integrationKey, source, description, userName } = request;

    const body = JSON.stringify({
      event_action: 'trigger',
      routing_key: integrationKey,
      client: 'Backstage',
      client_url: source,
      payload: {
        summary: description,
        source: source,
        severity: 'error',
        class: 'manual trigger',
        custom_details: {
          user: userName,
        },
      },
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
      },
      body,
    };

    const url = this.config.eventsBaseUrl ?? 'https://events.pagerduty.com/v2';

    return this.request(`${url}/enqueue`, options);
  }

  private async findByUrl<T>(url: string): Promise<T> {
    const options = {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.pagerduty+json;version=2',
        'Content-Type': 'application/json',
      },
    };
    const response = await this.request(url, options);
    return response.json();
  }

  private async request(
    url: string,
    options: RequestOptions,
  ): Promise<Response> {
    const response = await this.config.fetchApi.fetch(url, options);
    if (response.status === 401) {
      throw new UnauthorizedError("Unauthorized: You don't have access to this resource");
    }

    if (response.status === 403) {
      throw new ForbiddenError("Forbidden: You are not allowed to perform this action");
    }

    if (response.status === 404) {
      throw new NotFoundError("Not Found: Resource not found");
    }

    if (!response.ok) {
      const payload = await response.json();
      const errors = payload.errors.map((error: string) => error).join(' ');
      const message = `Request failed with ${response.status}, ${errors}`;
      throw new Error(message);
    }
    return response;
  }
}
