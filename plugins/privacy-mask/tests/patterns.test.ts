// Unit tests of the masking rules. Every sample is made up: example.* domains,
// documentation IBANs and BSN test numbers that pass the 11-check.
import { describe, expect, test } from "claude-code/testing";

import {
  BAR,
  cleanNames,
  createMasker,
  isSecretName,
  isValidBsn,
  isValidIban,
  mask,
} from "../hooks/patterns";

const NO_NAMES: readonly string[] = [];
const plain = (text: string): string => mask(text, NO_NAMES);

describe("email", () => {
  test("an address is masked, the words around it stay", () => {
    expect(plain("Mail jan@example.nl today")).toBe(`Mail ${BAR} today`);
    expect(plain("<piet.de-boer+test@mail.example.com>")).toBe(`<${BAR}>`);
  });

  test("a package version or a bare @ is not an address", () => {
    expect(plain("eslint@8.57.0 and @types/node")).toBe(
      "eslint@8.57.0 and @types/node",
    );
  });
});

describe("phone", () => {
  test("Dutch forms are masked", () => {
    expect(plain("Bel 06-12345678.")).toBe(`Bel ${BAR}.`);
    expect(plain("Bel 0612345678")).toBe(`Bel ${BAR}`);
    expect(plain("Kantoor 020 123 4567")).toBe(`Kantoor ${BAR}`);
  });

  test("international forms are masked", () => {
    expect(plain("Call +31 6 12345678 now")).toBe(`Call ${BAR} now`);
    expect(plain("Call +31 (0)20 123 4567")).toBe(`Call ${BAR}`);
    expect(plain("Call +1 (555) 123-4567")).toBe(`Call ${BAR}`);
  });

  test("short numbers and versions are left", () => {
    expect(plain("Room 0612 and +31 6 1234")).toBe("Room 0612 and +31 6 1234");
    expect(plain("port 8080, 3 files")).toBe("port 8080, 3 files");
  });
});

describe("money", () => {
  test("Dutch and English formats are masked", () => {
    expect(plain("Total € 1.234,56 incl.")).toBe(`Total ${BAR} incl.`);
    expect(plain("Total €12,50.")).toBe(`Total ${BAR}.`);
    expect(plain("Price $99.95")).toBe(`Price ${BAR}`);
    expect(plain("Paid 1,234 EUR")).toBe(`Paid ${BAR}`);
    expect(plain("Paid EUR 250")).toBe(`Paid ${BAR}`);
    expect(plain("Costs USD 1,000.00 and £40")).toBe(`Costs ${BAR} and ${BAR}`);
    expect(plain("Prijs € 15,-")).toBe(`Prijs ${BAR}`);
  });

  test("numbers without a currency are left", () => {
    expect(plain("Version 1.234,56 and 1,234 items")).toBe(
      "Version 1.234,56 and 1,234 items",
    );
    expect(plain("EURO 2024 and NEUR 12")).toBe("EURO 2024 and NEUR 12");
  });
});

describe("IBAN", () => {
  test("the mod-97 check", () => {
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
    expect(isValidIban("NL91 ABNA 0417 1643 00")).toBe(true);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isValidIban("NL91ABNA0417164301")).toBe(false);
    expect(isValidIban("NL91ABNA")).toBe(false);
  });

  test("a valid IBAN is masked, with or without spaces", () => {
    expect(plain("IBAN NL91 ABNA 0417 1643 00 graag")).toBe(
      `IBAN ${BAR} graag`,
    );
    expect(plain("to DE89370400440532013000.")).toBe(`to ${BAR}.`);
  });

  test("a capital word after an IBAN does not hide it", () => {
    expect(plain("NL91ABNA0417164300 EUR")).toBe(`${BAR} EUR`);
  });

  test("an IBAN that fails the check is left", () => {
    expect(plain("NL91ABNA0417164301")).toBe("NL91ABNA0417164301");
  });
});

describe("BSN", () => {
  test("the 11-check", () => {
    expect(isValidBsn("111222333")).toBe(true);
    expect(isValidBsn("123456782")).toBe(true);
    expect(isValidBsn("123.45.678.2")).toBe(true);
    expect(isValidBsn("123456789")).toBe(false);
    expect(isValidBsn("000000000")).toBe(false);
    expect(isValidBsn("12345678")).toBe(false);
  });

  test("nine digits passing the check are masked, with spaces or dots", () => {
    expect(plain("BSN 111222333.")).toBe(`BSN ${BAR}.`);
    expect(plain("BSN 1234 56 782")).toBe(`BSN ${BAR}`);
    expect(plain("BSN 123.456.782")).toBe(`BSN ${BAR}`);
  });

  test("nine digits failing the check, or part of a longer number, are left", () => {
    expect(plain("Order 123456789")).toBe("Order 123456789");
    expect(plain("Id 1234567820")).toBe("Id 1234567820");
  });
});

describe("postcode with house number", () => {
  test("postcode plus number is masked", () => {
    expect(plain("Adres: 1234 AB 12, Utrecht")).toBe(`Adres: ${BAR}, Utrecht`);
    expect(plain("Adres: 1234AB 12a")).toBe(`Adres: ${BAR}`);
  });

  test("a postcode alone is left", () => {
    expect(plain("1234 AB Utrecht")).toBe("1234 AB Utrecht");
    expect(plain("in 2024 is 12")).toBe("in 2024 is 12");
  });
});

describe("secrets", () => {
  test("known key prefixes are masked", () => {
    const samples = [
      "sk-proj-AbCdEf1234567890",
      "sk_live_AbCdEf1234567890",
      "ghp_AbCdEf1234567890AbCd",
      "gho_AbCdEf1234567890AbCd",
      "xoxb-1234567890-AbCdEf",
      "xoxp-1234567890-AbCdEf",
      "glpat-AbCdEf1234567890",
      "AKIAABCDEFGHIJKLMNOP",
      "AIzaSyAbCdEf1234567890AbCdEf",
    ];

    for (const sample of samples) {
      expect(plain(`key ${sample} end`)).toBe(`key ${BAR} end`);
    }
  });

  test("a Bearer token and a JWT are masked", () => {
    expect(plain("Authorization: Bearer abc.DEF-123_xyz")).toBe(
      `Authorization: Bearer ${BAR}`,
    );
    expect(plain("token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl")).toBe(
      `token ${BAR}`,
    );
  });

  test("the value of a KEY=value line is masked, the name stays", () => {
    expect(plain("API_KEY=abc123")).toBe(`API_KEY=${BAR}`);
    expect(plain("export DB_PASSWORD='two words'")).toBe(
      `export DB_PASSWORD='${BAR}'`,
    );
    expect(plain('github_token = "x y"')).toBe(`github_token = "${BAR}"`);
    expect(plain("MYSQL_PWD=hunter2 next")).toBe(`MYSQL_PWD=${BAR} next`);
    expect(plain("url?token=abc&page=2")).toBe(`url?token=${BAR}&page=2`);
    expect(plain("client_secret=s3cr3t")).toBe(`client_secret=${BAR}`);
  });

  test("the value of a JSON secret is masked", () => {
    expect(plain('{"apiKey": "abc123", "name": "demo"}')).toBe(
      `{"apiKey": "${BAR}", "name": "demo"}`,
    );
    expect(plain('{"Password":"hunter2"}')).toBe(`{"Password":"${BAR}"}`);
  });

  test("lookalikes are left", () => {
    expect(plain("task-runner and risk-free")).toBe(
      "task-runner and risk-free",
    );
    expect(plain("if (pass == null)")).toBe("if (pass == null)");
    expect(plain("open example.config.json")).toBe("open example.config.json");
    expect(plain("NAME=demo")).toBe("NAME=demo");
  });
});

describe("names", () => {
  test("listed names are masked whole word, any case, longest first", () => {
    const maskText = createMasker(["Jan", "Jan de Vries", "Acme Holding"]);

    expect(maskText("Met jan de  vries en JAN van ACME holding.")).toBe(
      `Met ${BAR} en ${BAR} van ${BAR}.`,
    );
  });

  test("a name inside a longer word is left", () => {
    const maskText = createMasker(["Jan"]);

    expect(maskText("Januari and Jansen")).toBe("Januari and Jansen");
  });

  test("names with accents and regex characters work", () => {
    const maskText = createMasker(["José", "C++ Team"]);

    expect(maskText("Hoi José, de c++ team is klaar")).toBe(
      `Hoi ${BAR}, de ${BAR} is klaar`,
    );
  });

  test("the list is cleaned: trimmed, short and duplicate names dropped", () => {
    expect(cleanNames(["  Jan  ", "J", "", "jan", 42, "Jan de Vries"])).toEqual(
      ["Jan de Vries", "Jan"],
    );
    expect(createMasker(["J", " "])("J is here")).toBe("J is here");
  });
});

describe("mixed text", () => {
  test("a sample with every kind keeps its plain words", () => {
    const maskText = createMasker(["Piet Jansen"]);
    const text = [
      "Klant Piet Jansen (piet@example.nl, 06-12345678)",
      "Adres 1234 AB 12, BSN 111222333",
      "IBAN NL91ABNA0417164300, open: € 1.234,56",
      "STRIPE_KEY=sk_live_AbCdEf1234567890",
    ].join("\n");

    expect(maskText(text)).toBe(
      [
        `Klant ${BAR} (${BAR}, ${BAR})`,
        `Adres ${BAR}, BSN ${BAR}`,
        `IBAN ${BAR}, open: ${BAR}`,
        `STRIPE_KEY=${BAR}`,
      ].join("\n"),
    );
  });

  test("an empty text stays empty", () => {
    expect(plain("")).toBe("");
  });
});

describe("review additions", () => {
  test("Dutch area code in brackets and the 00 dialling form are masked", () => {
    expect(plain("Bel (020) 123 4567.")).toBe(`Bel ${BAR}.`);
    expect(plain("Bel 0031 6 12345678")).toBe(`Bel ${BAR}`);
    expect(plain("Zie (020) 123 en 0031 6")).toBe("Zie (020) 123 en 0031 6");
  });

  test("an IBAN in lower case is masked when it passes the check", () => {
    expect(plain("iban nl91 abna 0417 1643 00 ok")).toBe(`iban ${BAR} ok`);
    expect(plain("iban nl91abna0417164301")).toBe("iban nl91abna0417164301");
  });

  test("a postcode in lower case is masked when written against the digits", () => {
    expect(plain("Adres 1234ab 12")).toBe(`Adres ${BAR}`);
    // With a space between, capitals only, to keep prose like `in 2024 is 12` out.
    expect(plain("Adres 1234 ab 12")).toBe("Adres 1234 ab 12");
  });

  test("a YAML-style secret at the start of a line is masked", () => {
    expect(plain("api_key: abc123")).toBe(`api_key: ${BAR}`);
    expect(plain("db:\n  password: 'two words' # local")).toBe(
      `db:\n  password: '${BAR}' # local`,
    );
    expect(plain("- github_token: tok123")).toBe(`- github_token: ${BAR}`);
    expect(plain("The key: we ship today")).toBe("The key: we ship today");
    expect(plain("api_key:")).toBe("api_key:");
  });

  test("bearer in any case, with a real token, is masked", () => {
    expect(plain("authorization: bearer abcdEFGH1234")).toBe(
      `authorization: bearer ${BAR}`,
    );
    expect(plain("AUTHORIZATION: BEARER abcdEFGH1234")).toBe(
      `AUTHORIZATION: BEARER ${BAR}`,
    );
    expect(plain("the bearer of bad news")).toBe("the bearer of bad news");
  });

  test("sk_test_ keys are masked", () => {
    expect(plain("key sk_test_AbCdEf1234567890 end")).toBe(`key ${BAR} end`);
    expect(plain("desk_test_runner")).toBe("desk_test_runner");
  });

  test("a JSON secret value with escaped quotes is masked whole", () => {
    expect(plain('{"password": "a\\"b c", "user": "demo"}')).toBe(
      `{"password": "${BAR}", "user": "demo"}`,
    );
  });

  test("a long run of secret words is masked quickly", () => {
    const maskText = createMasker(["Piet Jansen"]);
    const runs = [
      "key".repeat(70_000),
      `"${"key".repeat(70_000)}`,
      `${"key".repeat(70_000)} = x`,
    ];

    for (const text of runs) {
      const started = Date.now();
      maskText(text);
      expect(Date.now() - started).toBeLessThan(100);
    }
  });

  test("field names that mark a secret", () => {
    expect(isSecretName("password")).toBe(true);
    expect(isSecretName("API_KEY")).toBe(true);
    expect(isSecretName("accessToken")).toBe(true);
    expect(isSecretName("command")).toBe(false);
    expect(isSecretName("file_path")).toBe(false);
  });
});
