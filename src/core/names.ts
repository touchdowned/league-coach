/**
 * Match-v5 and Data Dragon spell champions by key ("MonkeyKing", "LeeSin", "Kaisa"). Those keys
 * stay the ids everywhere (portraits, kits, joins); this turns one into the name the game shows.
 */
const IRREGULAR: Record<string, string> = {
  MonkeyKing: "Wukong",
  Chogath: "Cho'Gath",
  Kaisa: "Kai'Sa",
  Khazix: "Kha'Zix",
  KogMaw: "Kog'Maw",
  Velkoz: "Vel'Koz",
  RekSai: "Rek'Sai",
  Belveth: "Bel'Veth",
  KSante: "K'Sante",
  Leblanc: "LeBlanc",
  Nunu: "Nunu & Willump",
  DrMundo: "Dr. Mundo",
  JarvanIV: "Jarvan IV",
  Renata: "Renata Glasc",
  FiddleSticks: "Fiddlesticks",
  Fiddlesticks: "Fiddlesticks",
};

export function champName(key: string | null | undefined): string {
  if (!key) return "";
  if (IRREGULAR[key]) return IRREGULAR[key];
  // "LeeSin" -> "Lee Sin", "MissFortune" -> "Miss Fortune", "AurelionSol" -> "Aurelion Sol".
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}
