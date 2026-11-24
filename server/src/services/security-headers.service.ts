import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker } from 'src/enum.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { createSecurityHeaders, getMapCspSources } from 'src/utils/security-headers.js';

@Injectable()
export class SecurityHeadersService extends BaseService {
  private mapSources: string[] = [];

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Api] })
  onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.mapSources = getMapCspSources(newConfig.map);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Api], server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    this.mapSources = getMapCspSources(newConfig.map);
  }

  getMapSources() {
    return this.mapSources;
  }

  middleware() {
    const { helmet, resourcePaths, security } = this.configRepository.getEnv();
    const { messages, middleware } = createSecurityHeaders(
      {
        helmetPolicy: !!helmet.config?.contentSecurityPolicy,
        contentSecurityPolicy: security.contentSecurityPolicy,
        webRoot: resourcePaths.web.root,
      },
      () => this.mapSources,
    );

    for (const message of messages) {
      this.logger.warn(message);
    }

    return middleware;
  }
}
