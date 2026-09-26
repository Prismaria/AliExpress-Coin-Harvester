import { describe, expect, it } from "vitest";
import { md5 } from "../src/shared/md5";
import {
  isMtopAuthenticationError,
  isMtopTokenExpired,
  normalizeMtopStats,
  parseMtopJsonp,
  type MtopStatsPayload
} from "../src/shared/mtop-stats";

describe("page-context MTop contracts", () => {
  it("matches standard MD5 vectors used by the MTop signer", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("parses JSONP envelopes and identifies expired tokens", () => {
    const expired = parseMtopJsonp('mtopjsonp1({"data":{},"ret":["FAIL_SYS_TOKEN_EXOIRED::令牌过期"]})');
    expect(isMtopTokenExpired(expired)).toBe(true);

    const successful = parseMtopJsonp('mtopjsonp2({"data":{"data":[],"success":true},"ret":["SUCCESS::调用成功"]})');
    expect(isMtopTokenExpired(successful)).toBe(false);
  });

  it("recognizes authentication failures without treating transport errors as logout", () => {
    expect(isMtopAuthenticationError(new Error("UserCoinNum: FAIL_SYS_USER_VALIDATE::Please login"))).toBe(true);
    expect(isMtopAuthenticationError(new Error("UserCoinNum: FAIL_SYS_TOKEN_EXOIRED::令牌过期"))).toBe(true);
    expect(isMtopAuthenticationError(new Error("MTop JSONP request timed out"))).toBe(false);
  });

  it("normalizes balance, lifetime, event metadata, and all history categories", () => {
    const payload: MtopStatsPayload = {
      pageUrl: "https://m.aliexpress.com/p/coin-index/index.html?private=1",
      balance: [
        { name: "userCoinsNum", value: 881 },
        { name: "valueMoney", value: "C$12.61" }
      ],
      lifetime: {
        coinSaveFormatPrice: JSON.stringify({ structure: { formatPrice: "C$327.57" } })
      },
      earned: [
        { date: 1789632025000, eventType: "complete_mission", formatTime: "Thu Sep 17 01:00:25 PDT 2026", num: 5, subject: "Coin page task", sequence: 0 },
        { date: 1789632025000, eventType: "complete_mission", formatTime: "Thu Sep 17 01:00:25 PDT 2026", num: 5, subject: "Coin page task", sequence: 1 }
      ],
      used: [
        { date: 1788722256000, eventType: "PRODUCT_EXCHANGE", extendAttr1: 8213773616184950, num: -76, subject: "Purchase", sequence: 0 }
      ],
      expired: [
        { date: 1788245999000, num: 50, subject: "Expired", sequence: 0 }
      ],
      eventTypes: {
        earned: [{ key: "pc_check_in", name: "Website daily check-in" }],
        used: [{ key: "PRODUCT_EXCHANGE", name: "Purchase" }]
      }
    };

    const snapshot = normalizeMtopStats(payload, 1_700_000_000_000);
    expect(snapshot).toMatchObject({
      accountState: "authenticated",
      coinCountRaw: "881",
      currentSavingsRaw: "C$12.61",
      lifetimeSavingsRaw: "C$327.57",
      source: {
        kind: "page-mtop",
        url: "https://m.aliexpress.com/p/coin-index/index.html",
        observedAt: 1_700_000_000_000
      },
      historyEventTypes: {
        earned: [{ key: "pc_check_in", name: "Website daily check-in" }],
        used: [{ key: "PRODUCT_EXCHANGE", name: "Purchase" }]
      }
    });
    expect(snapshot.history).toHaveLength(4);
    expect(snapshot.history[0]).toMatchObject({
      category: "earned",
      amountRaw: "+5",
      eventType: "complete_mission",
      timestamp: 1789632025000
    });
    expect(snapshot.history[0].id).not.toBe(snapshot.history[1].id);
    expect(snapshot.history[2]).toMatchObject({
      id: "used:8213773616184950",
      category: "used",
      amountRaw: "-76"
    });
    expect(snapshot.history[3]).toMatchObject({ category: "expired", title: "Expired", amountRaw: "+50" });
  });
});
