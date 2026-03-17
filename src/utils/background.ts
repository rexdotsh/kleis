export const runInBackground = (promise: Promise<unknown>): void => {
  promise.catch(() => undefined);
};
