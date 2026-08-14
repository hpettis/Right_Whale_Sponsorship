// Pulls the Whales, Sightings, and Updates tables from Airtable and writes them out as
// data/whales.json, data/sightings.json, data/updates.json in the shape index.html expects.
//
// Requires two environment variables at runtime:
//   AIRTABLE_TOKEN    - a Personal Access Token, scoped read-only to this base
//   AIRTABLE_BASE_ID  - this base's ID (starts with "app...")
//
// Run locally with:  AIRTABLE_TOKEN=xxx AIRTABLE_BASE_ID=xxx node scripts/sync-airtable.mjs

import fs from "node:fs/promises";

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;

// If any of your actual Airtable field names differ from what's listed here, update the
// strings on the right-hand side of each TABLES/FIELDS entry below to match exactly
// (Airtable field names are case-sensitive).
const TABLES = { whales: "Whales", sightings: "Sightings", updates: "Updates" };

if (!AIRTABLE_TOKEN || !BASE_ID) {
  console.error("Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID environment variable.");
  process.exit(1);
}

async function fetchAllRecords(tableName) {
  let records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) {
      throw new Error(`Airtable API error fetching "${tableName}": ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// The Sightings/Updates "Whale" field is a link (an array containing one record ID), not
// the whale's name directly - this turns that ID back into a plain whale name using the
// Whales records we already fetched.
function buildWhaleNameLookup(whalesRecords) {
  const byId = {};
  whalesRecords.forEach(r => { byId[r.id] = r.fields["Whale Name"] || ""; });
  return byId;
}

function linkedWhaleName(fields, whaleNameById) {
  const linkedId = Array.isArray(fields["Whale"]) ? fields["Whale"][0] : null;
  return linkedId ? (whaleNameById[linkedId] || "") : "";
}

async function main() {
  console.log("Fetching Whales...");
  const whalesRecords = await fetchAllRecords(TABLES.whales);
  console.log(`  ${whalesRecords.length} whale record(s)`);

  console.log("Fetching Sightings...");
  const sightingsRecords = await fetchAllRecords(TABLES.sightings);
  console.log(`  ${sightingsRecords.length} sighting record(s)`);

  console.log("Fetching Updates...");
  const updatesRecords = await fetchAllRecords(TABLES.updates);
  console.log(`  ${updatesRecords.length} update record(s)`);

  const whaleNameById = buildWhaleNameLookup(whalesRecords);

  // ---------- whales.json ----------
  const whales = whalesRecords
    .map(r => {
      const f = r.fields;
      const photo = Array.isArray(f["Photo"]) && f["Photo"].length ? f["Photo"][0].url : "";
      return {
        name: f["Whale Name"] || "",
        eg: f["EG Number"] || "",
        sex: f["Sex"] || "",
        birthYear: typeof f["Birth Year"] === "number" ? f["Birth Year"] : null,
        about: f["About"] || "",
        sponsored: !!f["Sponsored"],
        photoUrl: photo,
        photoCredit: f["Photo Credit"] || ""
      };
    })
    .filter(w => w.name);

  // ---------- sightings.json ----------
  const sightings = sightingsRecords
    .map(r => {
      const f = r.fields;
      return {
        whale: linkedWhaleName(f, whaleNameById),
        date: f["Date"] || "",
        latitude: typeof f["Latitude"] === "number" ? f["Latitude"] : null,
        longitude: typeof f["Longitude"] === "number" ? f["Longitude"] : null,
        region: f["Region"] || "",
        notes: f["Notes"] || "",
        behavior: f["Behavior"] || ""
      };
    })
    .filter(s => s.whale && s.latitude !== null && s.longitude !== null);

  // ---------- updates.json ----------
  const updates = updatesRecords
    .map(r => {
      const f = r.fields;
      return {
        whale: linkedWhaleName(f, whaleNameById),
        date: f["Date"] || "",
        text: f["Update Text"] || "",
        published: !!f["Published"]
      };
    })
    .filter(u => u.whale && u.text);

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/whales.json", JSON.stringify(whales, null, 2));
  await fs.writeFile("data/sightings.json", JSON.stringify(sightings, null, 2));
  await fs.writeFile("data/updates.json", JSON.stringify(updates, null, 2));

  console.log(`Wrote data/whales.json (${whales.length}), data/sightings.json (${sightings.length}), data/updates.json (${updates.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
