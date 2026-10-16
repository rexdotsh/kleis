import { expect, test } from "bun:test";
import { sendWithAuthReplay } from "../../src/http/auth-replay";

test.each([
  { firstStatus: 401, secondStatus: 200, refresh: "new", statuses: [401, 200] },
  { firstStatus: 401, secondStatus: 401, refresh: "new", statuses: [401, 401] },
  {
    firstStatus: 200,
    secondStatus: 200,
    refresh: "forbidden",
    statuses: [200],
  },
  { firstStatus: 401, secondStatus: 200, refresh: "fail", statuses: [401] },
  {
    firstStatus: 401,
    secondStatus: 200,
    refresh: "unchanged",
    statuses: [401],
  },
])(
  "replays only a rejected credential, at most once: %j",
  async ({ firstStatus, secondStatus, refresh, statuses }) => {
    const sent: { token: string; status: number }[] = [];
    let refreshes = 0;
    const original = { id: "account", accessToken: "old" };
    const result = await sendWithAuthReplay({
      account: original,
      send: async (account) => {
        const status = sent.length ? secondStatus : firstStatus;
        sent.push({ token: account.accessToken, status });
        return { response: new Response("upstream body", { status }) };
      },
      refresh: async () => {
        refreshes++;
        if (refresh === "fail" || refresh === "forbidden")
          throw new Error("refresh failed");
        return refresh === "new"
          ? { ...original, accessToken: "new" }
          : original;
      },
    });
    expect(sent.map((entry) => entry.status)).toEqual(statuses);
    expect(sent.map((entry) => entry.token)).toEqual(
      statuses.length === 2 ? ["old", "new"] : ["old"]
    );
    expect(result.attempt.response.status).toBe(statuses.at(-1));
    expect(await result.attempt.response.text()).toBe("upstream body");
    expect(result.replayed).toBe(statuses.length === 2);
    expect(refreshes).toBe(firstStatus === 401 ? 1 : 0);
  }
);
