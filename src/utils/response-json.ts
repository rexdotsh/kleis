export const readResponseJson = async (
  response: Response,
  description: string
): Promise<unknown> => {
  const bytes = await response.arrayBuffer();
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // Native parse errors can quote credentials or provider content in their stacks.
    throw new SyntaxError(
      `${description} is not valid JSON (HTTP ${response.status}, ${bytes.byteLength} bytes)`
    );
  }
};
