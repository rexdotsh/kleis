export const requireOkResponse = async (
  response: Response,
  messagePrefix: string
): Promise<void> => {
  if (response.ok) {
    return;
  }

  const errorText = await response.text();
  throw new Error(`${messagePrefix} (${response.status}): ${errorText}`);
};
