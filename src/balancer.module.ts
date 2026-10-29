import { DynamicModule, MiddlewareConsumer, Module, NestModule, Provider, RequestMethod } from '@nestjs/common';
import { ROUTE_BALANCER_OPTIONS, ROUTE_BALANCER_PLUGINS } from './options';
import { RouteBalancerService } from './balancer.service';
import { RouteBalancerMiddleware } from './proxy/middleware';
import type { RouteBalancerAsyncOptions, RouteBalancerOptions, RouteBalancerPlugin } from './types';

function wildcardRoutePath(): string {
  try {
    const pkg = require('@nestjs/core/package.json') as { version?: string };
    const major = Number.parseInt(pkg.version?.split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major < 11) return '*';
  } catch {
    // Fall through to the Nest 11+ syntax.
  }
  return '{*path}';
}

@Module({})
export class RouteBalancerModule implements NestModule {
  static forRoot(options: RouteBalancerOptions, plugins: RouteBalancerAsyncOptions['plugins'] = {}): DynamicModule {
    const pluginProvider: Provider = {
      provide: ROUTE_BALANCER_PLUGINS,
      useFactory: (...resolved: RouteBalancerPlugin[]) => resolved,
      inject: plugins.inject ?? [],
    };
    return {
      module: RouteBalancerModule,
      imports: plugins.imports ?? [],
      providers: [
        ...(plugins.providers ?? []),
        { provide: ROUTE_BALANCER_OPTIONS, useValue: options },
        pluginProvider,
        RouteBalancerService,
        RouteBalancerMiddleware,
      ],
      exports: [RouteBalancerService],
    };
  }
  static forRootAsync(options: RouteBalancerAsyncOptions): DynamicModule {
    const pluginRegistration = options.plugins ?? {};
    const factory: Provider = { provide: ROUTE_BALANCER_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] };
    const plugins: Provider = {
      provide: ROUTE_BALANCER_PLUGINS,
      useFactory: (...resolved: RouteBalancerPlugin[]) => resolved,
      inject: pluginRegistration.inject ?? [],
    };
    return {
      module: RouteBalancerModule,
      imports: [...new Set([...(options.imports ?? []), ...(pluginRegistration.imports ?? [])])],
      providers: [
        ...(pluginRegistration.providers ?? []),
        factory,
        plugins,
        RouteBalancerService,
        RouteBalancerMiddleware,
      ],
      exports: [RouteBalancerService],
    };
  }
  configure(consumer: MiddlewareConsumer): void {
    // Register globally, then match configured route prefixes inside middleware.
    // This also avoids coupling registration to a static forRootAsync configuration.
    consumer.apply(RouteBalancerMiddleware).forRoutes({ path: wildcardRoutePath(), method: RequestMethod.ALL });
  }
}
