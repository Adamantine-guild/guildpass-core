import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  correlationId: string;
};

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

export function setRequestContext(context: RequestContext): void {
  requestContextStorage.enterWith(context);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return getRequestContext()?.correlationId;
}
