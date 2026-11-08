import { describe, expect, it } from "vite-plus/test";
import { LANGUAGES, translationProblems } from "./translate.ts";

const en = LANGUAGES.en!;
const italian =
  "Il nuraghe è costruito con grandi massi di basalto.\n\nDella torre restano pochi filari.";

describe("translationProblems", () => {
  it("passes a faithful translation", () => {
    const english =
      "The nuraghe is built of large basalt boulders.\n\nOnly a few courses of the tower remain.";
    expect(translationProblems(italian, english, en)).toEqual([]);
  });

  it("flags lost paragraphs, a preamble and a lost census term", () => {
    expect(
      translationProblems(
        italian,
        "Here is the translation: the tower is built of large basalt boulders, of which a few courses remain.",
        en,
      ),
    ).toEqual(["paragraphs 2 → 1", "preamble or markup", 'lost "nurag"']);
  });

  it("allows an opening the Italian has too", () => {
    expect(
      translationProblems(
        '"Domus de janas di Orrilì. Sulle pendici del monte.',
        '"Domus de janas of Orrilì. On the slopes of the mountain.',
        en,
      ),
    ).toEqual([]);
    expect(translationProblems("Qui anche un ammezzato.", "Here also a mezzanine.", en)).toEqual(
      [],
    );
    expect(translationProblems("Nuraghe.", '"Nuraghe."', en)).toContain("preamble or markup");
  });

  it("lets a translation join a paragraph the source broke mid-sentence", () => {
    const broken = "Il monumento, a NO del Nuraghe\n\nSu Figu, è sepolto.\n\nResta poco.";
    expect(
      translationProblems(
        broken,
        "The monument, NW of the Nuraghe Su Figu, is buried.\n\nLittle remains.",
        en,
      ),
    ).toEqual([]);
    expect(translationProblems(broken, "The monument is buried and little remains.", en)).toContain(
      "paragraphs 3 → 1",
    );
  });

  it("tells a chat opening from a sentence that starts the same way", () => {
    expect(
      translationProblems(
        "Certamente un nuraghe importante.",
        "Certainly an important nuraghe.",
        en,
      ),
    ).toEqual([]);
    expect(
      translationProblems("Un nuraghe importante.", "Sure, here it is: an important nuraghe.", en),
    ).toContain("preamble or markup");
    expect(
      translationProblems('nuraghe "a tancato" a Macomer.', '"Tancato" nuraghe at Macomer.', en),
    ).toEqual([]);
  });

  it("flags a glossary example copied into the text", () => {
    for (const english of [
      "A single-tower (single-tower) nuraghe.",
      "A single-tower (single-tower nuraghe) by the road.",
    ])
      expect(translationProblems("Un nuraghe monotorre.", english, en)).toContain(
        "repeated in brackets",
      );
  });

  it("leaves quoted Italian titles alone", () => {
    expect(
      translationProblems(
        "Vedasi libro di Giuseppa Tanda “L'arte delle domus de janas” pag. 97.",
        "See Giuseppa Tanda's book “L'arte delle domus de janas”, page 97.",
        en,
      ),
    ).toEqual([]);
  });

  it("flags the model's own tokens", () => {
    const english =
      "The nuraghe is built of large basalt boulders.<|im_end|>\n\nOnly a few courses of the tower remain.";
    expect(translationProblems(italian, english, en)).toEqual(["model token"]);
  });

  it("flags text left in Italian, or cut off", () => {
    expect(translationProblems(italian, italian, en)).toContain("not translated");
    const half = "The nuraghe is built of large basalt boulders.\n\nOnly a few";
    expect(translationProblems(italian, half, en, true)).toContain("cut off");
  });
});
