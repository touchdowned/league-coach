import { describe, expect, it } from "vitest";
import { champKey, champName } from "../src/core/names";

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

describe("champKey", () => {
  it("turns display names back into Data Dragon keys", () => {
    expect(champKey("Lee Sin")).toBe("LeeSin");
    expect(champKey("Wukong")).toBe("MonkeyKing");
    expect(champKey("Kai'Sa")).toBe("Kaisa");
    expect(champKey("Nunu & Willump")).toBe("Nunu");
    expect(champKey("Dr. Mundo")).toBe("DrMundo");
    expect(champKey("LeBlanc")).toBe("Leblanc");
  });
  it("keeps keys as they are", () => {
    for (const k of ["LeeSin", "MonkeyKing", "Kaisa", "Ahri", "JarvanIV"]) expect(champKey(k)).toBe(k);
  });
});
