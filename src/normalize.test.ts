import { describe, expect, it } from "vite-plus/test";
import {
  extractLinks,
  normalizeParagraphs,
  normalizeText,
  sourceAddress,
  textProblems,
} from "./normalize.ts";

// NUR4134 upstream, shortened
const LEAKED =
  'pecode="NUR" typedescr="Nurnet - sito archeologico"><descr>Nuraghe Monte Idu</descr>' +
  '<attributes><attribute name="Comune" attributetype="Monotext"><monotext>Teulada</monotext>' +
  '</attribute><attribute name="Note" attributetype="Longtext"><text lang="en">Questo nuraghe è ' +
  "sul limite del poligono militare.\n\nIl nuraghe sembra essere un monotorre</";

describe("text cleanup", () => {
  it("keeps only the note of a raw portal record", () => {
    expect(normalizeParagraphs(LEAKED)).toBe(
      "Questo nuraghe è sul limite del poligono militare.\n\nIl nuraghe sembra essere un monotorre",
    );
  });

  it("leaves ordinary descriptions alone", () => {
    expect(normalizeParagraphs("Alto 5 m, < 10 m dal fiume.")).toBe("Alto 5 m, < 10 m dal fiume.");
  });

  it("decodes HTML entities, also encoded twice", () => {
    expect(normalizeText("Studio C&amp;C")).toBe("Studio C&C");
    expect(normalizeText("meno di &amp;lt; 2 m, perch&#232;")).toBe("meno di < 2 m, perchè");
  });

  it("drops a stray < or > inside a word", () => {
    expect(normalizeText("Su T&lt;empiesu")).toBe("Su Tempiesu");
  });

  it("adds the missing space after a full stop, not in links or abbreviations", () => {
    expect(normalizeParagraphs("dei tempi.Si accede. Prof.Ercole")).toBe(
      "dei tempi. Si accede. Prof. Ercole",
    );
    expect(normalizeParagraphs("S.Antonio, www.sardegna.it/Nuraghi.Losa")).toBe(
      "S.Antonio, www.sardegna.it/Nuraghi.Losa",
    );
  });
});

describe("encoding and paragraphs", () => {
  it("fixes UTF-8 read as Latin-1", () => {
    expect(normalizeText("Domus Pedredu nÂ° VIII")).toBe("Domus Pedredu n° VIII");
    expect(normalizeText("perchÃ¨")).toBe("perchè");
  });

  it("joins paragraphs broken mid-sentence, keeps real ones", () => {
    expect(normalizeParagraphs("rimangono solo\n\nalcuni filari.\n\nL'ingresso era a S.")).toBe(
      "rimangono solo alcuni filari.\n\nL'ingresso era a S.",
    );
    expect(normalizeParagraphs("a 250 metri a NO del\n\nNuraghe Arghentu, in")).toBe(
      "a 250 metri a NO del Nuraghe Arghentu, in",
    );
    // NUR12346: before a bracket or a quotation, as before a lowercase word
    expect(
      normalizeParagraphs('d\'età altomedievale\n\n(VII sec. d. C.). Al Museo\n\n"G. A. Sanna".'),
    ).toBe('d\'età altomedievale (VII sec. d. C.). Al Museo "G. A. Sanna".');
  });
});

describe("extractLinks", () => {
  it("takes the addresses out of the text, sentence punctuation kept", () => {
    expect(
      extractLinks(
        "alcuni massi sono inglobati nel muretto della chiesa www.aserramanna.it/storia/ www.serramanna.altervista.org/storia.htm",
      ),
    ).toEqual({
      text: "alcuni massi sono inglobati nel muretto della chiesa",
      links: [
        { url: "http://www.aserramanna.it/storia/" },
        { url: "http://www.serramanna.altervista.org/storia.htm" },
      ],
    });
    expect(
      extractLinks("Filari ordinati.\n\nInfo: www.archeologosardos.it\n\nVedi Tiriàles."),
    ).toEqual({
      text: "Filari ordinati.\n\nVedi Tiriàles.",
      links: [{ url: "http://www.archeologosardos.it" }],
    });
  });

  it("turns the cut-off Merella address into the thesis, with its pages", () => {
    const { text, links } = extractLinks(
      "Pianta irregolare.\n\nPer approfondire:\n\neprints.uniss.it/9371/1/Merella_S_Indagini_territoriali... pagg. 339-340",
    );
    expect(text).toBe("Pianta irregolare.");
    expect(links).toEqual([
      {
        url: expect.stringContaining("iris.uniss.it"),
        label: "Merella, Indagini territoriali, pp. 339–340",
      },
    ]);
    expect(
      extractLinks("eprints.uniss.it/9371/1/Merella_S_Indagini_territoriali...\n\nPagine: 273-274")
        .text,
    ).toBe("");
  });

  it("keeps an address's own scheme", () => {
    expect(extractLinks("http://www.tharros.info/NuraghiMap.php?lng=it#tabs-3")).toEqual({
      text: "",
      links: [{ url: "http://www.tharros.info/NuraghiMap.php?lng=it#tabs-3" }],
    });
  });

  it("leaves a bare site name, and text without addresses, as they are", () => {
    const text = "Da Tharros.info. Posizione non esattamente definita";
    expect(extractLinks(text)).toEqual({ text, links: [] });
  });
});

describe("sourceAddress", () => {
  it("gives a bare address its scheme", () => {
    expect(sourceAddress("sardegnacultura.it")).toBe("http://sardegnacultura.it");
    expect(sourceAddress("www.ilportalesardo.it/archeo/nudorgali7.htm")).toBe(
      "http://www.ilportalesardo.it/archeo/nudorgali7.htm",
    );
  });

  it("leaves names, full addresses and addresses that are gone as they are", () => {
    for (const source of [
      "mario unali",
      "G.Lilliu",
      "Moravetti 1998",
      "https://www.nurnet.net/x",
      "Villanovaforru.gov.it",
      "comune.ittiri.ss.it/web/pg/eta-nuragica/5",
    ])
      expect(sourceAddress(source)).toBe(source);
  });
});

describe("textProblems", () => {
  it("finds markup, entities and broken encoding", () => {
    const problems = (text: string) => textProblems(text).map((p) => p.problem);
    expect(problems(LEAKED)).toContain("markup");
    expect(problems("C&amp;C")).toEqual(["HTML entity"]);
    expect(problems("perchÃ¨")).toEqual(["broken encoding"]);
    expect(problems("Nuraghe Losa, alto 12 m.")).toEqual([]);
  });
});
