import { describe, expect, it } from "vitest";
import { champName } from "../src/core/names";

describe("champName", () => {
  it("spaces camel-case keys", () => {
    expect(champName("LeeSin")).toBe("Lee Sin");
    expect(champName("MissFortune")).toBe("Miss Fortune");
    expect(champName("TwistedFate")).toBe("Twisted Fate");
    expect(champName("XinZhao")).toBe("Xin Zhao");
  });
  it("uses the game's spelling for irregular keys", () => {
    expect(champName("MonkeyKing")).toBe("Wukong");
    expect(champName("Kaisa")).toBe("Kai'Sa");
    expect(champName("KSante")).toBe("K'Sante");
    expect(champName("JarvanIV")).toBe("Jarvan IV");
    expect(champName("DrMundo")).toBe("Dr. Mundo");
  });
  it("leaves plain names and display names alone", () => {
    expect(champName("Ahri")).toBe("Ahri");
    expect(champName("Lee Sin")).toBe("Lee Sin");
    expect(champName("")).toBe("");
  });
});
