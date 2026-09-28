// Pulls the Whales, Sightings, and Updates tables from Airtable and writes them out as
// data/whales.json, data/sightings.json, data/updates.json in the shape index.html expects.
//
// Requires two environment variables at runtime:
//   AIRTABLE_TOKEN    - a Personal Access Token, scoped read-only to this base
//   AIRTABLE_BASE_ID  - this base's ID (starts with "app...")
//
// Run locally with:  AIRTABLE_TOKEN=xxx AIRTABLE_BASE_ID=xxx node scripts/sync-airtable.mjs

import fs from "node:fs/promises";
import path from "node:path";

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;

// Airtable's attachment links are temporary signed URLs that expire after a couple of hours,
// so they can't be used directly on the live site. Instead, each whale's photo is downloaded
// into this folder (which gets committed to the repo and served by GitHub Pages).
const PHOTO_DIR = "images/whales";
// Which version of the photo to download: "large" (about 512px on the longest side, small
// files) or "full" (up to 3000px, sharper but bigger files).
const PHOTO_SIZE = "full";

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

const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// Downloads one Airtable attachment into PHOTO_DIR and returns its repo-relative path.
// The file is named using the attachment's unique ID, which changes whenever a new photo is
// uploaded in Airtable - so an unchanged photo is only downloaded once (later runs reuse it),
// and a replaced photo gets a new filename, which also avoids stale browser caching.
async function saveWhalePhoto(attachment, baseName, keepFiles) {
  const safeBase = `${baseName}-${attachment.id}`.replace(/[^A-Za-z0-9_-]/g, "");

  const existing = (await fs.readdir(PHOTO_DIR)).find(n => n.startsWith(safeBase + "."));
  if (existing) {
    keepFiles.add(existing);
    return `${PHOTO_DIR}/${existing}`;
  }

  const sourceUrl = (attachment.thumbnails && attachment.thumbnails[PHOTO_SIZE] && attachment.thumbnails[PHOTO_SIZE].url) || attachment.url;
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const fileName = `${safeBase}.${EXT_BY_TYPE[type] || "jpg"}`;
  await fs.writeFile(path.join(PHOTO_DIR, fileName), Buffer.from(await res.arrayBuffer()));
  keepFiles.add(fileName);
  return `${PHOTO_DIR}/${fileName}`;
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

  // ---------- whales.json (also downloads each whale's photo into images/whales/) ----------
  await fs.mkdir(PHOTO_DIR, { recursive: true });
  const keepFiles = new Set();
  const whales = [];

  for (const r of whalesRecords) {
    const f = r.fields;
    const name = f["Whale Name"] || "";
    if (!name) continue;

    let photoUrl = "";
    const attachment = Array.isArray(f["Photo"]) ? f["Photo"][0] : null;
    if (attachment) {
      try {
        photoUrl = await saveWhalePhoto(attachment, f["EG Number"] || r.id, keepFiles);
      } catch (err) {
        console.warn(`  Could not download photo for ${name}: ${err.message}`);
      }
    }

    whales.push({
      name,
      eg: f["EG Number"] || "",
      sex: f["Sex"] || "",
      birthYear: typeof f["Birth Year"] === "number" ? f["Birth Year"] : null,
      about: f["About"] || "",
      sponsored: !!f["Sponsored"],
      photoUrl,
      photoCredit: f["Photo Credit"] || "",
      photoDescription: f["Photo Description"] || ""
    });
  }

  // Remove downloaded photos that no longer belong to any whale (e.g. a photo that was
  // replaced or removed in Airtable), so the repo doesn't slowly fill up with old files.
  if (whales.length > 0) {
    for (const file of await fs.readdir(PHOTO_DIR)) {
      if (!keepFiles.has(file)) await fs.unlink(path.join(PHOTO_DIR, file));
    }
  }

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
