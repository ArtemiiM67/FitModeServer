import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USDA_API_KEY = process.env.USDA_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY");
}
if (!USDA_API_KEY) {
  console.warn("Missing USDA_API_KEY");
}

const client = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const macroSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    Calories: { type: "number" },
    Protein: { type: "number" },
    Carbs: { type: "number" },
    Fat: { type: "number" },
    notes: { type: "string" },
  },
  required: ["Calories", "Protein", "Carbs", "Fat", "notes"],
};

function asNumber(value, fallback = 0) {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function looksBranded(query) {
  const q = query.toLowerCase().trim();

  const hints = [
    "quest",
    "fairlife",
    "chobani",
    "oikos",
    "premier protein",
    "barebells",
    "ghost",
    "ryse",
    "yasso",
    "kirkland",
    "great value",
    "trader joe",
    "aldi",
    "costco",
    "oreo",
    "doritos",
    "lays",
    "gatorade",
    "monster",
    "red bull",
    "mcdonald",
    "burger king",
    "chipotle",
  ];

  if (hints.some((h) => q.includes(h))) return true;

  const words = q.split(/\s+/).filter(Boolean);
  const hasLongSpecificPhrase = words.length >= 3;
  const hasFlavorWords = [
    "vanilla",
    "chocolate",
    "strawberry",
    "cookies",
    "cream",
  ].some((w) => q.includes(w));

  return hasLongSpecificPhrase && hasFlavorWords;
}

function nutrientFromSearch(food, nutrientName) {
  const nutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  const item = nutrients.find((n) => n?.nutrientName === nutrientName);
  return asNumber(item?.value, 0);
}

function nutrientFromDetails(food, nutrientName) {
  const nutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  for (const item of nutrients) {
    if (item?.nutrientName === nutrientName) {
      return asNumber(item?.amount ?? item?.value, 0);
    }
    if (item?.nutrient?.name === nutrientName) {
      return asNumber(item?.amount ?? item?.value, 0);
    }
  }
  return 0;
}

function nutrientFromNames(food, names) {
  const nutrients = Array.isArray(food.foodNutrients)
    ? food.foodNutrients
    : [];

  for (const item of nutrients) {
    const possibleNames = [
      item?.nutrientName,
      item?.nutrient?.name,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());

    const matched = names.some((target) =>
      possibleNames.some((name) =>
        name.includes(target.toLowerCase())
      )
    );

    if (matched) {
      return asNumber(item?.amount ?? item?.value, 0);
    }
  }

  return 0;
}

function normalizeUsdaSearchFood(food) {
  return {
    source: "usda",
    id: String(food.fdcId),
    fdcId: food.fdcId,
    name: String(food.description ?? "Unknown food"),
    brandName: food.brandOwner || food.brandName || null,
    dataType: food.dataType || null,

    caloriesPer100g: nutrientFromSearch(food, "Energy"),
    proteinPer100g: nutrientFromSearch(food, "Protein"),
    carbsPer100g: nutrientFromSearch(
      food,
      "Carbohydrate, by difference"
    ),
    fatPer100g: nutrientFromSearch(
      food,
      "Total lipid (fat)"
    ),

    sodiumMgPer100g: nutrientFromNames(food, ["sodium"]),
    fiberPer100g: nutrientFromNames(food, ["fiber"]),
    sugarPer100g: nutrientFromNames(food, [
      "sugars",
      "total sugars",
    ]),
    saturatedFatPer100g: nutrientFromNames(food, [
      "saturated",
      "fatty acids, total saturated",
    ]),
    potassiumMgPer100g: nutrientFromNames(food, [
      "potassium",
    ]),

    servingGrams: food.servingSize
      ? asNumber(food.servingSize, 0)
      : null,

    servingUnit: food.servingSizeUnit || null,
    verifiedBarcode: false,
  };
}

function normalizeUsdaDetails(food) {
  return {
    source: "usda",
    id: String(food.fdcId),
    fdcId: food.fdcId,
    name: String(food.description ?? "Unknown food"),
    brandName: food.brandOwner || food.brandName || null,
    dataType: food.dataType || null,

    caloriesPer100g: nutrientFromDetails(food, "Energy"),
    proteinPer100g: nutrientFromDetails(food, "Protein"),
    carbsPer100g: nutrientFromDetails(
      food,
      "Carbohydrate, by difference"
    ),
    fatPer100g: nutrientFromDetails(
      food,
      "Total lipid (fat)"
    ),

    sodiumMgPer100g: nutrientFromNames(food, ["sodium"]),
    fiberPer100g: nutrientFromNames(food, ["fiber"]),
    sugarPer100g: nutrientFromNames(food, [
      "sugars",
      "total sugars",
    ]),
    saturatedFatPer100g: nutrientFromNames(food, [
      "saturated",
      "fatty acids, total saturated",
    ]),
    potassiumMgPer100g: nutrientFromNames(food, [
      "potassium",
    ]),

    servingGrams: food.servingSize
      ? asNumber(food.servingSize, 0)
      : null,

    servingUnit: food.servingSizeUnit || null,
    verifiedBarcode: false,
  };
}

function normalizeOpenFoodFacts(product) {
  const nutriments = product?.nutriments || {};
  const servingText = product?.serving_size || null;

  return {
    source: "openfoodfacts",
    id: String(product?._id || product?.code || ""),
    barcode: product?.code || null,
    name: product?.product_name || "Unknown product",
    brandName: product?.brands || null,
    dataType: "Branded",
    caloriesPer100g: asNumber(
      nutriments["energy-kcal_100g"] ?? nutriments["energy-kcal"],
      0
    ),
	sodiumMgPer100g:
    nutriments["sodium_100g"] != null
      ? asNumber(nutriments["sodium_100g"], 0) * 1000
      : 0,

	fiberPer100g: asNumber(
		nutriments["fiber_100g"],
		0
	),

	sugarPer100g: asNumber(
		nutriments["sugars_100g"],
		0
	),

	saturatedFatPer100g: asNumber(
		nutriments["saturated-fat_100g"],
		0
	),

	potassiumMgPer100g:
		nutriments["potassium_100g"] != null
			? asNumber(nutriments["potassium_100g"], 0) * 1000
			: 0,
			
	proteinPer100g: asNumber(nutriments["proteins_100g"], 0),
    carbsPer100g: asNumber(nutriments["carbohydrates_100g"], 0),
    fatPer100g: asNumber(nutriments["fat_100g"], 0),
    servingGrams: null,
    servingUnit: servingText,
    verifiedBarcode: true,
    imageUrl: product?.image_url || product?.image_front_url || null,
  };
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_/.,()+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordList(value) {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

function wordPrefixMatch(words, token) {
  return words.some((word) => word.startsWith(token));
}

function countPrefixMatches(words, tokens) {
  let count = 0;
  for (const token of tokens) {
    if (wordPrefixMatch(words, token)) count += 1;
  }
  return count;
}

function allTokensMatch(words, tokens) {
  if (tokens.length === 0) return false;
  return tokens.every((token) => wordPrefixMatch(words, token));
}

function scoreFood(item, query) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = wordList(query);

  const normalizedName = normalizeSearchText(item.name || "");
  const normalizedBrand = normalizeSearchText(item.brandName || "");
  const combined = `${normalizedName} ${normalizedBrand}`.trim();

  const nameWords = wordList(item.name || "");
  const brandWords = wordList(item.brandName || "");
  const combinedWords = wordList(combined);
  const type = (item.dataType || "").toLowerCase();

  let score = 0;

  if (!normalizedQuery) return score;

  if (normalizedName === normalizedQuery) score += 200;
  if (normalizedName.startsWith(normalizedQuery)) score += 120;
  if (normalizedBrand === normalizedQuery) score += 80;
  if (normalizedBrand.startsWith(normalizedQuery)) score += 40;

  const combinedPrefixMatches = countPrefixMatches(combinedWords, tokens);
  const namePrefixMatches = countPrefixMatches(nameWords, tokens);
  const brandPrefixMatches = countPrefixMatches(brandWords, tokens);

  score += combinedPrefixMatches * 35;
  score += namePrefixMatches * 20;
  score += brandPrefixMatches * 12;

  if (allTokensMatch(nameWords, tokens)) score += 80;
  else if (allTokensMatch(combinedWords, tokens)) score += 40;
  else score -= 35;

  if (item.caloriesPer100g > 0) score += 8;
  if (item.proteinPer100g > 0) score += 6;
  if (item.carbsPer100g > 0) score += 6;
  if (item.fatPer100g > 0) score += 6;

  if (looksBranded(query)) {
    if (type.includes("branded")) score += 20;
    if (normalizedBrand) score += 12;
  } else {
    if (type.includes("foundation")) score += 20;
    if (type.includes("legacy")) score += 16;
    if (type.includes("survey")) score += 12;
    if (type.includes("branded")) score -= 10;
  }

  if (
    item.caloriesPer100g === 0 &&
    item.proteinPer100g === 0 &&
    item.carbsPer100g === 0 &&
    item.fatPer100g === 0
  ) {
    score -= 30;
  }

  return score;
}

function parseModelJsonOrThrow(response) {
  const raw = response?.output_text;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("Invalid AI JSON:", raw);
    throw new Error("Model returned invalid JSON");
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/macros/text", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server" });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Estimate meal macros. Output must match the JSON schema exactly.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Meal description: ${text}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "macro_estimate",
          schema: macroSchema,
        },
      },
    });

    const parsed = parseModelJsonOrThrow(response);
    res.json(parsed);
  } catch (e) {
    console.error("TEXT ERROR:", e);
    res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

app.post("/macros/image", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server" });
    }

    const { image_base64, mime = "image/jpeg", hint = "" } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: "Missing image_base64" });
    }

    const dataUrl = `data:${mime};base64,${image_base64}`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Estimate meal macros from the image. Output must match the JSON schema exactly.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: dataUrl,
            },
            {
              type: "input_text",
              text: hint
                ? `Extra context: ${hint}`
                : "Estimate macros for the meal shown.",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "macro_estimate",
          schema: macroSchema,
        },
      },
    });

    const parsed = parseModelJsonOrThrow(response);
    res.json(parsed);
  } catch (e) {
    console.error("IMAGE ERROR:", e);
    res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

app.post("/food/search", async (req, res) => {
  try {
    if (!USDA_API_KEY) {
      return res.status(500).json({ error: "Missing USDA_API_KEY on server" });
    }

    const rawQuery = String(req.body?.query || "").trim();
    const query = normalizeSearchText(rawQuery);

    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    const body = {
      query,
      pageSize: 20,
      dataType: ["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"],
    };

    const usdaResp = await fetch(
      `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(
        USDA_API_KEY
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!usdaResp.ok) {
      const text = await usdaResp.text();
      return res.status(500).json({ error: `USDA search failed: ${text}` });
    }

    const usdaData = await usdaResp.json();
    const foods = Array.isArray(usdaData?.foods) ? usdaData.foods : [];

    const scored = foods
      .map(normalizeUsdaSearchFood)
      .map((item) => ({
        item,
        score: scoreFood(item, query),
      }))
      .filter((entry) => entry.score > -20)
      .sort((a, b) => b.score - a.score);

    const seen = new Set();
    const deduped = [];

    for (const entry of scored) {
      const item = entry.item;
      const key = `${normalizeSearchText(item.name)}|${normalizeSearchText(
        item.brandName || ""
      )}`;

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);

      if (deduped.length >= 12) break;
    }

    res.json({ results: deduped });
  } catch (e) {
    console.error("FOOD SEARCH ERROR:", e);
    res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

app.get("/food/details", async (req, res) => {
  try {
    if (!USDA_API_KEY) {
      return res.status(500).json({ error: "Missing USDA_API_KEY on server" });
    }

    const fdcId = String(req.query?.fdcId || "").trim();
    if (!fdcId) {
      return res.status(400).json({ error: "Missing fdcId" });
    }

    const usdaResp = await fetch(
      `https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(
        fdcId
      )}?api_key=${encodeURIComponent(USDA_API_KEY)}`
    );

    if (!usdaResp.ok) {
      const text = await usdaResp.text();
      return res.status(500).json({ error: `USDA details failed: ${text}` });
    }

    const usdaData = await usdaResp.json();
    const normalized = normalizeUsdaDetails(usdaData);

    res.json(normalized);
  } catch (e) {
    console.error("FOOD DETAILS ERROR:", e);
    res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

app.get("/food/barcode", async (req, res) => {
  try {
    const barcode = String(req.query?.barcode || "").trim();
    if (!barcode) {
      return res.status(400).json({ error: "Missing barcode" });
    }

    const offResp = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
        barcode
      )}.json?fields=code,product_name,brands,_id,serving_size,nutriments,image_url,image_front_url`
    );

    if (!offResp.ok) {
      const text = await offResp.text();
      return res.status(500).json({ error: `Barcode lookup failed: ${text}` });
    }

    const offData = await offResp.json();
    if (!offData?.product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const normalized = normalizeOpenFoodFacts(offData.product);

    if (!normalized.name || normalized.name === "Unknown product") {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(normalized);
  } catch (e) {
    console.error("BARCODE ERROR:", e);
    res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`FitMode backend running on port ${PORT}`);
});