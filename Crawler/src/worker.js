// README:
// 1) Create D1 and apply schema:
//    wrangler d1 create crawler
//    wrangler d1 execute crawler --file=./schema.sql
//    Update wrangler.toml with the returned database_id.
// 2) Set secrets:
//    wrangler secret put OPENAI_API_KEY
//    wrangler secret put ADMIN_TOKEN
// 3) Deploy:
//    wrangler deploy
// 4) Update allowlist:
//    Edit allowlist.txt and redeploy.

import allowlistText from "../allowlist.txt";

const ALLOWLIST = parseAllowlist(allowlistText);

const RANK_MODEL = "gpt-4o-mini";
const MAX_RANK_BATCH = 200;
const RANK_THRESHOLD = 50;
const LOCK_SECONDS = 900;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/") {
      return handleHome(request, env);
    }

    if (request.method === "POST" && path === "/ui/topic/init") {
      return handleUiTopicInit(request, env);
    }

    if (request.method === "POST" && path === "/ui/crawl/enqueue") {
      return handleUiCrawlEnqueue(request, env, ctx);
    }

    if (request.method === "POST" && path === "/ui/rank/trigger") {
      return handleUiRankTrigger(request, env, ctx);
    }

    if (request.method === "GET" && path === "/api/books") {
      return handleApiBooks(url, env);
    }

    if (request.method === "GET" && path === "/api/stats") {
      return handleApiStats(url, env);
    }

    if (request.method === "GET" && path === "/api/allowlist") {
      return jsonResponse(serializeAllowlist(ALLOWLIST));
    }

    if (request.method === "POST" && path === "/api/topic/init") {
      const body = await readJson(request);
      return handleTopicInit(body, env);
    }

    if (request.method === "POST" && path === "/api/crawl/enqueue") {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return auth.response;
      const body = await readJson(request);
      return handleCrawlEnqueue(body, env, ctx);
    }

    if (request.method === "POST" && path === "/api/rank/trigger") {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return auth.response;
      const body = await readJson(request);
      return handleRankTrigger(body, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};

async function handleHome(request, env) {
  const url = new URL(request.url);
  const topic = normalizeTopic(url.searchParams.get("topic") || "");
  const msg = cleanText(url.searchParams.get("msg") || "");
  const err = cleanText(url.searchParams.get("err") || "");
  let stats = null;
  let books = [];
  if (topic) {
    stats = await getTopicStats(env, topic);
    books = await listRankedBooks(env, topic, 100);
  }

  const html = renderHomeHtml(topic, stats, books, msg, err);
  return htmlResponse(html);
}

async function handleUiTopicInit(request, env) {
  const form = await readForm(request);
  const topic = normalizeTopic(form.topic || "");
  if (!topic) return redirectResponse("/", { err: "topic is required" });

  const result = await initTopic(env, topic);
  const insertedCount = (result.inserted || []).length;
  return redirectResponse("/", {
    topic,
    msg: "topic initialized (seeds inserted: " + insertedCount + ")"
  });
}

async function handleUiCrawlEnqueue(request, env, ctx) {
  const form = await readForm(request);
  const topic = normalizeTopic(form.topic || "");
  if (!topic) return redirectResponse("/", { err: "topic is required" });

  const auth = requireAdminToken(form.admin_token, env);
  if (!auth.ok) return redirectResponse("/", { topic, err: auth.error || "unauthorized" });

  const result = await enqueueCrawlForTopic(env, topic, ctx);
  return redirectResponse("/", {
    topic,
    msg: "crawl enqueued (urls: " + result.enqueued + ")"
  });
}

async function handleUiRankTrigger(request, env, ctx) {
  const form = await readForm(request);
  const topic = normalizeTopic(form.topic || "");
  if (!topic) return redirectResponse("/", { err: "topic is required" });

  const auth = requireAdminToken(form.admin_token, env);
  if (!auth.ok) return redirectResponse("/", { topic, err: auth.error || "unauthorized" });

  const force = normalizeBool(form.force);
  const result = await triggerRankingForTopic(env, topic, force, ctx);
  if (result.status === "skipped") {
    return redirectResponse("/", {
      topic,
      msg: "rank skipped (" + result.reason + ")"
    });
  }
  return redirectResponse("/", {
    topic,
    msg: "rank job queued (" + result.job_id + ")"
  });
}

async function handleApiBooks(url, env) {
  const topic = normalizeTopic(url.searchParams.get("topic") || "");
  if (!topic) {
    return jsonResponse({ error: "topic is required" }, 400);
  }
  const books = await listRankedBooks(env, topic, 200);
  return jsonResponse({ topic, books });
}

async function handleApiStats(url, env) {
  const topic = normalizeTopic(url.searchParams.get("topic") || "");
  if (!topic) {
    return jsonResponse({ error: "topic is required" }, 400);
  }
  const stats = await getTopicStats(env, topic);
  return jsonResponse(stats);
}

async function handleTopicInit(body, env) {
  const topic = normalizeTopic(body.topic || "");
  if (!topic) {
    return jsonResponse({ error: "topic is required" }, 400);
  }

  const result = await initTopic(env, topic);
  return jsonResponse(result);
}

async function handleCrawlEnqueue(body, env, ctx) {
  const topic = normalizeTopic(body.topic || "");
  if (!topic) {
    return jsonResponse({ error: "topic is required" }, 400);
  }

  const result = await enqueueCrawlForTopic(env, topic, ctx);
  return jsonResponse(result);
}

async function handleRankTrigger(body, env, ctx) {
  const topic = normalizeTopic(body.topic || "");
  const force = Boolean(body.force);
  if (!topic) {
    return jsonResponse({ error: "topic is required" }, 400);
  }

  const result = await triggerRankingForTopic(env, topic, force, ctx);
  return jsonResponse(result);
}

async function initTopic(env, topic) {
  const now = nowSeconds();
  const seeds = buildSeedUrls(topic);
  const statements = [];
  const skipped = [];
  const inserted = [];

  statements.push(
    env.DB.prepare("INSERT INTO topic_state (topic) VALUES (?) ON CONFLICT(topic) DO NOTHING").bind(topic)
  );

  for (const seed of seeds) {
    if (!isAllowedUrl(seed.url)) {
      skipped.push({ source: seed.source, url: seed.url, reason: "not allowlisted" });
      continue;
    }

    inserted.push({ source: seed.source, url: seed.url });

    statements.push(
      env.DB.prepare(
        "INSERT INTO crawl_targets (topic, source, seed, recrawl_days) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(topic, source, seed) DO UPDATE SET recrawl_days = excluded.recrawl_days"
      ).bind(topic, seed.source, seed.url, 7)
    );

    statements.push(
      env.DB.prepare(
        "INSERT INTO crawl_urls (url, topic, source, status, next_crawl_at) VALUES (?, ?, ?, 'queued', ?) " +
          "ON CONFLICT(url) DO UPDATE SET status = 'queued', next_crawl_at = excluded.next_crawl_at, last_error = NULL"
      ).bind(seed.url, topic, seed.source, now)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return { topic, inserted, skipped };
}

async function enqueueCrawlForTopic(env, topic, ctx) {
  const now = nowSeconds();
  await env.DB.prepare("UPDATE crawl_urls SET status = 'queued', next_crawl_at = ? WHERE topic = ?")
    .bind(now, topic)
    .run();

  const rows = await env.DB.prepare("SELECT url, topic, source FROM crawl_urls WHERE topic = ?")
    .bind(topic)
    .all();

  const targets = rows.results || [];
  if (ctx && targets.length) {
    ctx.waitUntil(processDueCrawls(env, topic, 50));
  }

  return { enqueued: targets.length, topic };
}

async function triggerRankingForTopic(env, topic, force, ctx) {
  const stats = await getTopicStats(env, topic);
  if (!force && stats.unranked_books <= RANK_THRESHOLD) {
    return { status: "skipped", reason: "threshold_not_met", stats };
  }

  await env.DB.prepare(
    "INSERT INTO topic_state (topic, manual_requested_at) VALUES (?, ?) " +
      "ON CONFLICT(topic) DO UPDATE SET manual_requested_at = excluded.manual_requested_at"
  ).bind(topic, nowSeconds()).run();

  const jobId = await createRankingJob(env, topic, force ? "manual_force" : "manual");
  if (ctx) {
    ctx.waitUntil(processQueuedRankingJobs(env, 1));
  }
  return { status: "queued", job_id: jobId, topic, stats };
}

async function handleScheduled(event, env) {
  const cron = event && event.cron ? String(event.cron) : "";
  const runCrawl = !cron || cron.indexOf("*/15") !== -1;
  const runRank = !cron || cron.indexOf("*/30") !== -1;
  if (runCrawl) await processDueCrawls(env, null, 100);
  if (runRank) {
    await enqueueAutoRankings(env);
    await processQueuedRankingJobs(env, 2);
  }
}

async function processDueCrawls(env, topic, limit) {
  const now = nowSeconds();
  const cap = limit && Number(limit) > 0 ? Number(limit) : 100;
  let stmt;
  if (topic) {
    stmt = env.DB.prepare(
      "SELECT url, topic, source FROM crawl_urls WHERE topic = ? AND next_crawl_at <= ? AND status IN ('queued', 'fail') LIMIT ?"
    ).bind(topic, now, cap);
  } else {
    stmt = env.DB.prepare(
      "SELECT url, topic, source FROM crawl_urls WHERE next_crawl_at <= ? AND status IN ('queued', 'fail') LIMIT ?"
    ).bind(now, cap);
  }

  const rows = await stmt.all();
  const targets = rows.results || [];
  for (const row of targets) {
    await handleCrawlJob({ url: row.url, topic: row.topic, source: row.source }, env);
  }
}

async function enqueueAutoRankings(env) {
  const rows = await env.DB.prepare(
    "SELECT b.topic AS topic, COUNT(*) AS unranked " +
      "FROM books b " +
      "LEFT JOIN rankings r ON b.id = r.book_id AND r.topic = b.topic " +
      "WHERE r.book_id IS NULL " +
      "GROUP BY b.topic " +
      "HAVING unranked > ? " +
      "LIMIT 20"
  ).bind(RANK_THRESHOLD).all();

  const topics = rows.results || [];
  for (const row of topics) {
    const topic = row.topic;
    const locked = await isTopicLocked(env.DB, topic);
    if (locked) continue;
    const openJob = await hasOpenRankingJob(env.DB, topic);
    if (openJob) continue;
    await createRankingJob(env, topic, "auto_threshold");
  }
}

async function handleCrawlJob(payload, env) {
  const url = payload.url;
  const topic = payload.topic;
  const source = payload.source || detectSourceFromUrl(url);
  if (!url || !topic || !source) return;

  if (!isAllowedUrl(url)) {
    await markCrawlBlocked(env.DB, url, topic, source, "not allowlisted");
    return;
  }

  const existing = await env.DB.prepare(
    "SELECT etag, last_modified, fail_count FROM crawl_urls WHERE url = ?"
  ).bind(url).first();

  const headers = {};
  if (existing && existing.etag) headers["If-None-Match"] = existing.etag;
  if (existing && existing.last_modified) headers["If-Modified-Since"] = existing.last_modified;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    await markCrawlFail(env.DB, url, topic, source, existing, "fetch_failed");
    return;
  }

  if (res.status === 304) {
    await markCrawlSuccess(env.DB, url, topic, source, res.headers, existing, []);
    return;
  }

  if (!res.ok) {
    await markCrawlFail(env.DB, url, topic, source, existing, "http_" + res.status);
    return;
  }

  let books = [];
  try {
    if (source === "openlibrary") {
      const data = await res.json();
      books = parseOpenLibrary(data, topic);
    } else if (source === "doab") {
      const data = await res.json();
      books = parseDoab(data, topic);
    } else if (source === "gutenberg") {
      const text = await res.text();
      books = parseGutenberg(url, text, topic);
    } else {
      const data = await res.json();
      books = parseGenericJson(data, topic, source);
    }
  } catch (err) {
    await markCrawlFail(env.DB, url, topic, source, existing, "parse_failed");
    return;
  }

  await upsertBooks(env, books);
  await markCrawlSuccess(env.DB, url, topic, source, res.headers, existing, books);
}

async function handleRankJob(payload, env) {
  const topic = payload.topic;
  const jobId = payload.job_id;
  if (!topic || !jobId) return;

  const now = nowSeconds();
  const lockOk = await acquireTopicLock(env.DB, topic, jobId, now);
  if (!lockOk) {
    await updateRankingJob(env.DB, jobId, "queued", "topic_locked", null, null, null);
    return;
  }

  await updateRankingJob(env.DB, jobId, "running", null, now, null, null);

  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT b.id, b.title, b.authors, b.year, b.language, b.license_hint, b.source " +
        "FROM books b " +
        "LEFT JOIN rankings r ON b.id = r.book_id AND r.topic = b.topic " +
        "WHERE b.topic = ? AND r.book_id IS NULL " +
        "LIMIT ?"
    ).bind(topic, MAX_RANK_BATCH).all();
  } catch (err) {
    await updateRankingJob(env.DB, jobId, "error", "db_select_failed", now, nowSeconds(), String(err));
    await releaseTopicLock(env.DB, topic, null);
    return;
  }

  const books = rows.results || [];
  if (books.length === 0) {
    const finished = nowSeconds();
    await updateRankingJob(env.DB, jobId, "empty", "no_unranked", now, finished, null);
    await releaseTopicLock(env.DB, topic, finished);
    return;
  }

  let ranked;
  try {
    ranked = await rankBooksWithLlm(env, topic, books);
  } catch (err) {
    const finished = nowSeconds();
    await updateRankingJob(env.DB, jobId, "error", "llm_failed", now, finished, String(err));
    await releaseTopicLock(env.DB, topic, null);
    return;
  }

  if (!ranked.length) {
    const finished = nowSeconds();
    await updateRankingJob(env.DB, jobId, "error", "llm_empty", now, finished, "empty_response");
    await releaseTopicLock(env.DB, topic, null);
    return;
  }

  const statements = [];
  const rankedAt = nowSeconds();
  for (const item of ranked) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO rankings (topic, book_id, score, rationale, ranked_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(topic, book_id) DO UPDATE SET score = excluded.score, rationale = excluded.rationale, ranked_at = excluded.ranked_at"
      ).bind(topic, item.book_id, item.score, item.rationale, rankedAt)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  const finished = nowSeconds();
  await updateRankingJob(env.DB, jobId, "done", "ok", now, finished, null);
  await releaseTopicLock(env.DB, topic, finished);
}

async function upsertBooks(env, books) {
  if (!books || books.length === 0) return;
  const statements = [];
  const now = nowSeconds();

  for (const book of books) {
    if (!book || !book.landing_url || !book.title) continue;
    if (!isAllowedUrl(book.landing_url)) continue;

    const bookId = await sha256Hex(book.source + "|" + book.landing_url);
    const downloadUrl = isAllowedUrl(book.download_url) ? book.download_url : null;
    const authors = book.authors || null;

    statements.push(
      env.DB.prepare(
        "INSERT INTO books (id, topic, source, title, authors, year, language, license_hint, landing_url, download_url, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET " +
          "topic = excluded.topic, source = excluded.source, title = excluded.title, authors = excluded.authors, " +
          "year = excluded.year, language = excluded.language, license_hint = excluded.license_hint, " +
          "landing_url = excluded.landing_url, download_url = excluded.download_url, " +
          "updated_at = excluded.updated_at, created_at = books.created_at"
      ).bind(
        bookId,
        book.topic,
        book.source,
        book.title,
        authors,
        book.year || null,
        book.language || null,
        book.license_hint || null,
        book.landing_url,
        downloadUrl,
        now,
        now
      )
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

function parseOpenLibrary(data, topic) {
  const docs = Array.isArray(data && data.docs) ? data.docs : [];
  const books = [];
  for (const doc of docs) {
    const title = cleanText(doc.title || doc.title_suggest || "");
    if (!title) continue;
    const authors = listToString(doc.author_name);
    const year = toYear(doc.first_publish_year);
    const language = listToString(doc.language);
    const key = doc.key || "";
    const landingUrl = key ? "https://openlibrary.org" + key : "";
    books.push({
      id: null,
      topic,
      source: "openlibrary",
      title,
      authors,
      year,
      language,
      license_hint: doc.ebook_access || "openlibrary",
      landing_url: landingUrl,
      download_url: null
    });
  }
  return books;
}

function parseDoab(data, topic) {
  const items = extractDoabItems(data);
  const books = [];
  for (const item of items) {
    const title = cleanText(firstString(item.title, item.name, item.metadata && item.metadata.title, item["dc:title"]));
    if (!title) continue;

    const authors = listToString(
      item.authors || item.creator || (item.metadata && item.metadata.creator) || item["dc:creator"]
    );

    const year = toYear(
      item.year || item.publication_year || item.issued || (item.metadata && item.metadata.year)
    );

    const language = listToString(
      item.language || item.languages || (item.metadata && item.metadata.language) || item["dc:language"]
    );

    const license = cleanText(
      firstString(item.license, item.rights, item.rights_uri, item.license_hint, item["dc:rights"])
    );

    const landingUrl = pickUrl(
      item.url,
      item.landing_url,
      item.landingUrl,
      item.landing_page,
      item.web_url,
      item.webUrl,
      item.links && item.links.self,
      item.links && item.links.landing,
      item.id && typeof item.id === "string" ? item.id : null
    );

    const downloadUrl = pickUrl(
      item.download_url,
      item.downloadUrl,
      item.fulltext,
      item.bitstream,
      item.bitstreams,
      item.files,
      item.links && item.links.download,
      item.links && item.links.file
    );

    books.push({
      id: null,
      topic,
      source: "doab",
      title,
      authors,
      year,
      language,
      license_hint: license || "open_access",
      landing_url: landingUrl,
      download_url: downloadUrl
    });
  }

  return books;
}

function parseGutenberg(urlString, html, topic) {
  const url = new URL(urlString);
  const match = url.pathname.match(/\/ebooks\/(\d+)/);
  if (match) {
    const id = match[1];
    const title = cleanText(matchFirst(html, [
      /<meta\s+name="title"\s+content="([^"]+)"/i,
      /<h1[^>]*>([^<]+)<\/h1>/i,
      /<title>([^<]+)<\/title>/i
    ]));

    const author = cleanText(matchFirst(html, [
      /itemprop="creator"[^>]*>([^<]+)<\/a>/i,
      /Author:\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/i
    ]));

    const language = cleanText(matchFirst(html, [
      /Language:\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/i,
      /itemprop="inLanguage"[^>]*>([^<]+)<\/a>/i
    ]));

    const landingUrl = "https://www.gutenberg.org/ebooks/" + id;
    return [
      {
        id: null,
        topic,
        source: "gutenberg",
        title: title || "Project Gutenberg #" + id,
        authors: author || null,
        year: null,
        language: language || null,
        license_hint: "public_domain",
        landing_url: landingUrl,
        download_url: null
      }
    ];
  }

  const ids = new Set();
  const regex = /href="\/ebooks\/(\d+)"/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    ids.add(m[1]);
    if (ids.size >= 50) break;
  }

  const books = [];
  for (const id of ids) {
    books.push({
      id: null,
      topic,
      source: "gutenberg",
      title: "Project Gutenberg #" + id,
      authors: null,
      year: null,
      language: null,
      license_hint: "public_domain",
      landing_url: "https://www.gutenberg.org/ebooks/" + id,
      download_url: null
    });
  }

  return books;
}

function parseGenericJson(data, topic, source) {
  const items = Array.isArray(data) ? data : Array.isArray(data && data.items) ? data.items : [];
  const books = [];
  for (const item of items) {
    const title = cleanText(firstString(item.title, item.name));
    if (!title) continue;
    const authors = listToString(item.authors || item.creator || item.author);
    const year = toYear(item.year || item.published || item.publication_year);
    const language = listToString(item.language || item.languages);
    const license = cleanText(firstString(item.license, item.rights, item.license_hint));
    const landingUrl = pickUrl(item.url, item.landing_url, item.web_url, item.id);
    const downloadUrl = pickUrl(item.download_url, item.file, item.fulltext);

    books.push({
      id: null,
      topic,
      source,
      title,
      authors,
      year,
      language,
      license_hint: license,
      landing_url: landingUrl,
      download_url: downloadUrl
    });
  }
  return books;
}

async function markCrawlSuccess(db, url, topic, source, headers, existing, books) {
  const recrawlDays = await getRecrawlDays(db, topic, source, url);
  const now = nowSeconds();
  const next = now + recrawlDays * 86400;
  const etag = headers && headers.get ? headers.get("etag") : null;
  const lastModified = headers && headers.get ? headers.get("last-modified") : null;

  await db.prepare(
    "INSERT INTO crawl_urls (url, topic, source, status, last_crawled_at, next_crawl_at, etag, last_modified, fail_count, last_error) " +
      "VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, 0, NULL) " +
      "ON CONFLICT(url) DO UPDATE SET status = 'ok', last_crawled_at = excluded.last_crawled_at, " +
      "next_crawl_at = excluded.next_crawl_at, etag = excluded.etag, last_modified = excluded.last_modified, " +
      "fail_count = 0, last_error = NULL"
  ).bind(url, topic, source, now, next, etag, lastModified).run();
}

async function markCrawlBlocked(db, url, topic, source, reason) {
  const now = nowSeconds();
  await db.prepare(
    "INSERT INTO crawl_urls (url, topic, source, status, last_crawled_at, last_error) VALUES (?, ?, ?, 'blocked', ?, ?) " +
      "ON CONFLICT(url) DO UPDATE SET status = 'blocked', last_crawled_at = excluded.last_crawled_at, last_error = excluded.last_error"
  ).bind(url, topic, source, now, reason || "blocked").run();
}

async function markCrawlFail(db, url, topic, source, existing, errorCode) {
  const now = nowSeconds();
  const currentFail = (existing && existing.fail_count ? Number(existing.fail_count) : 0) + 1;
  const backoffHours = Math.min(Math.pow(2, currentFail), 24 * 7);
  const next = now + backoffHours * 3600;

  await db.prepare(
    "INSERT INTO crawl_urls (url, topic, source, status, last_crawled_at, next_crawl_at, fail_count, last_error) " +
      "VALUES (?, ?, ?, 'fail', ?, ?, ?, ?) " +
      "ON CONFLICT(url) DO UPDATE SET status = 'fail', last_crawled_at = excluded.last_crawled_at, " +
      "next_crawl_at = excluded.next_crawl_at, fail_count = excluded.fail_count, last_error = excluded.last_error"
  ).bind(url, topic, source, now, next, currentFail, errorCode || "error").run();
}

async function getRecrawlDays(db, topic, source, seed) {
  const row = await db.prepare(
    "SELECT recrawl_days FROM crawl_targets WHERE topic = ? AND source = ? AND seed = ?"
  ).bind(topic, source, seed).first();
  const value = row && row.recrawl_days ? Number(row.recrawl_days) : 7;
  return Number.isFinite(value) ? value : 7;
}

async function rankBooksWithLlm(env, topic, books) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const filtered = books.filter((book) => book && book.id);
  if (filtered.length === 0) return [];
  const payload = filtered.map((book) => ({
    book_id: book.id,
    title: book.title,
    authors: book.authors,
    year: book.year,
    language: book.language,
    source: book.source,
    license_hint: book.license_hint
  }));

  const system =
    "You are a strict JSON generator. Return ONLY a JSON array. " +
    "Each item must be {\"book_id\": string, \"score\": number 0-100, \"rationale\": string max 240 chars}. " +
    "Rank by foundational importance, authority, clarity, breadth depth, and timelessness or relevance.";

  const user =
    "Topic: " + topic + "\n" +
    "Books JSON: " + JSON.stringify(payload);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + env.OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: RANK_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    throw new Error("openai_http_" + response.status);
  }

  const data = await response.json();
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || "")
      : "";

  const bookIds = filtered.map((b) => b.id);
  return normalizeRankingResponse(text, bookIds);
}

function normalizeRankingResponse(text, bookIds) {
  let data = safeJsonParse(text, null);
  if (!Array.isArray(data)) {
    const extracted = extractJsonArray(text);
    if (extracted) {
      data = safeJsonParse(extracted, null);
    }
  }
  if (!Array.isArray(data) && data && Array.isArray(data.items)) {
    data = data.items;
  }
  if (!Array.isArray(data)) return [];

  const allowed = new Set(bookIds);
  const results = [];
  for (const item of data) {
    const id = item ? item.book_id || item.bookId : null;
    if (!id || !allowed.has(id)) continue;
    const score = clampScore(item.score);
    const rationale = truncateText(String(item.rationale || ""), 240);
    if (!rationale) continue;
    results.push({ book_id: id, score, rationale });
  }
  return results;
}

async function createRankingJob(env, topic, reason) {
  const jobId = crypto.randomUUID();
  const now = nowSeconds();
  await env.DB.prepare(
    "INSERT INTO ranking_jobs (job_id, topic, status, reason, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(jobId, topic, "queued", reason, now).run();

  return jobId;
}

async function updateRankingJob(db, jobId, status, reason, startedAt, finishedAt, error) {
  await db.prepare(
    "UPDATE ranking_jobs SET status = ?, reason = COALESCE(?, reason), started_at = COALESCE(?, started_at), " +
      "finished_at = COALESCE(?, finished_at), error = COALESCE(?, error) WHERE job_id = ?"
  ).bind(status, reason, startedAt, finishedAt, error, jobId).run();
}

async function hasOpenRankingJob(db, topic) {
  const row = await db.prepare(
    "SELECT job_id FROM ranking_jobs WHERE topic = ? AND status IN ('queued', 'running') LIMIT 1"
  ).bind(topic).first();
  return Boolean(row && row.job_id);
}

async function processQueuedRankingJobs(env, limit) {
  const cap = limit && Number(limit) > 0 ? Number(limit) : 1;
  const rows = await env.DB.prepare(
    "SELECT job_id, topic FROM ranking_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?"
  ).bind(cap).all();

  const jobs = rows.results || [];
  for (const job of jobs) {
    await handleRankJob({ topic: job.topic, job_id: job.job_id }, env);
  }
}

async function acquireTopicLock(db, topic, jobId, now) {
  const row = await db.prepare(
    "SELECT running_job_id, lock_expires_at FROM topic_state WHERE topic = ?"
  ).bind(topic).first();

  if (row && row.lock_expires_at && Number(row.lock_expires_at) > now) {
    if (row.running_job_id && row.running_job_id !== jobId) {
      return false;
    }
  }

  await db.prepare(
    "INSERT INTO topic_state (topic, running_job_id, lock_expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(topic) DO UPDATE SET running_job_id = excluded.running_job_id, lock_expires_at = excluded.lock_expires_at"
  ).bind(topic, jobId, now + LOCK_SECONDS).run();

  return true;
}

async function isTopicLocked(db, topic) {
  const row = await db.prepare(
    "SELECT running_job_id, lock_expires_at FROM topic_state WHERE topic = ?"
  ).bind(topic).first();
  if (!row) return false;
  if (!row.lock_expires_at) return false;
  const now = nowSeconds();
  return Number(row.lock_expires_at) > now && Boolean(row.running_job_id);
}

async function releaseTopicLock(db, topic, rankedAt) {
  if (rankedAt) {
    await db.prepare(
      "UPDATE topic_state SET running_job_id = NULL, lock_expires_at = NULL, last_ranked_at = ? WHERE topic = ?"
    ).bind(rankedAt, topic).run();
  } else {
    await db.prepare(
      "UPDATE topic_state SET running_job_id = NULL, lock_expires_at = NULL WHERE topic = ?"
    ).bind(topic).run();
  }
}

async function listRankedBooks(env, topic, limit) {
  const rows = await env.DB.prepare(
    "SELECT b.*, r.score, r.rationale, r.ranked_at " +
      "FROM rankings r JOIN books b ON b.id = r.book_id AND b.topic = r.topic " +
      "WHERE r.topic = ? ORDER BY r.score DESC LIMIT ?"
  ).bind(topic, limit).all();

  return (rows.results || []).map(sanitizeBookForDisplay);
}

async function getTopicStats(env, topic) {
  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM books WHERE topic = ?"
  ).bind(topic).first();

  const rankedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM rankings WHERE topic = ?"
  ).bind(topic).first();

  const unrankedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM books b LEFT JOIN rankings r ON b.id = r.book_id AND r.topic = b.topic " +
      "WHERE b.topic = ? AND r.book_id IS NULL"
  ).bind(topic).first();

  const stateRow = await env.DB.prepare(
    "SELECT running_job_id, last_ranked_at FROM topic_state WHERE topic = ?"
  ).bind(topic).first();

  return {
    topic,
    total_books: Number(totalRow && totalRow.count ? totalRow.count : 0),
    ranked_books: Number(rankedRow && rankedRow.count ? rankedRow.count : 0),
    unranked_books: Number(unrankedRow && unrankedRow.count ? unrankedRow.count : 0),
    running_job_id: stateRow ? stateRow.running_job_id : null,
    last_ranked_at: stateRow ? stateRow.last_ranked_at : null
  };
}

function sanitizeBookForDisplay(row) {
  const landing = isAllowedForDisplay(row.landing_url) ? row.landing_url : null;
  const download = isAllowedForDisplay(row.download_url) ? row.download_url : null;

  return {
    id: row.id,
    title: row.title,
    authors: row.authors || null,
    year: row.year || null,
    language: row.language || null,
    license_hint: row.license_hint || null,
    landing_url: landing,
    download_url: download,
    score: row.score != null ? row.score : null,
    rationale: row.rationale || null,
    source: row.source || null
  };
}

function renderHomeHtml(topic, stats, books, msg, err) {
  const safeTopic = escapeHtml(topic || "");
  const topicParam = encodeURIComponent(topic || "");
  const msgHtml = msg ? "<div class=\"msg\">" + escapeHtml(msg) + "</div>" : "";
  const errHtml = err ? "<div class=\"err\">" + escapeHtml(err) + "</div>" : "";
  const statsHtml = stats
    ? "<div>total_books: " + stats.total_books + "</div>" +
      "<div>ranked_books: " + stats.ranked_books + "</div>" +
      "<div>unranked_books: " + stats.unranked_books + "</div>" +
      "<div>running_job_id: " + escapeHtml(stats.running_job_id || "") + "</div>" +
      "<div>last_ranked_at: " + (stats.last_ranked_at || "") + "</div>"
    : "<div>No topic selected.</div>";

  const listItems = (books || []).map((book) => {
    const title = escapeHtml(book.title || "");
    const authors = escapeHtml(book.authors || "");
    const rationale = escapeHtml(book.rationale || "");
    const score = book.score != null ? String(book.score) : "";

    const landingLink = book.landing_url
      ? "<a href=\"" + escapeHtml(book.landing_url) + "\" rel=\"noopener\">landing</a>"
      : "";

    const downloadLink = book.download_url
      ? "<a href=\"" + escapeHtml(book.download_url) + "\" rel=\"noopener\">download</a>"
      : "";

    return (
      "<li>" +
      "<div><strong>" + title + "</strong></div>" +
      "<div>Score: " + score + "</div>" +
      (authors ? "<div>Authors: " + authors + "</div>" : "") +
      (rationale ? "<div>Rationale: " + rationale + "</div>" : "") +
      "<div>" + landingLink + (landingLink && downloadLink ? " | " : "") + downloadLink + "</div>" +
      "</li>"
    );
  }).join("");

  return (
    "<!doctype html>" +
    "<html><head><meta charset=\"utf-8\">" +
    "<title>Open Access Book Ranker</title>" +
    "<style>" +
    "body{font-family:Arial,sans-serif;margin:24px;max-width:900px;}" +
    "input,button{padding:8px;font-size:14px;}" +
    "form{margin:0;}" +
    ".msg{background:#e7f5ff;border:1px solid #a5d8ff;padding:10px;border-radius:6px;margin:12px 0;}" +
    ".err{background:#fff5f5;border:1px solid #ffc9c9;padding:10px;border-radius:6px;margin:12px 0;}" +
    ".actions{margin:12px 0;padding:12px;border:1px solid #eee;border-radius:8px;background:#fafafa;}" +
    ".actions form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;}" +
    ".hint{color:#555;font-size:13px;margin:6px 0;}" +
    ".check{display:flex;align-items:center;gap:6px;}" +
    "ol{padding-left:20px;}" +
    "li{margin:12px 0;padding:12px;border:1px solid #ddd;border-radius:6px;}" +
    "</style></head><body>" +
    "<h1>Open Access Book Ranker</h1>" +
    errHtml +
    msgHtml +
    "<form method=\"GET\" action=\"/\">" +
    "<label>Topic</label> " +
    "<input type=\"text\" name=\"topic\" value=\"" + safeTopic + "\" size=\"40\"> " +
    "<button type=\"submit\">Search</button>" +
    "</form>" +
    "<div class=\"hint\">" +
    (topic ? "<a href=\"/api/stats?topic=" + topicParam + "\" rel=\"noopener\">stats json</a> | " : "") +
    (topic ? "<a href=\"/api/books?topic=" + topicParam + "\" rel=\"noopener\">books json</a> | " : "") +
    "<a href=\"/api/allowlist\" rel=\"noopener\">allowlist</a>" +
    "</div>" +
    "<h2>Actions</h2>" +
    "<div class=\"actions\">" +
    "<form method=\"POST\" action=\"/ui/topic/init\">" +
    "<input type=\"hidden\" name=\"topic\" value=\"" + safeTopic + "\">" +
    "<button type=\"submit\">Init topic</button>" +
    "</form>" +
    "<form method=\"POST\" action=\"/ui/crawl/enqueue\" autocomplete=\"off\">" +
    "<input type=\"hidden\" name=\"topic\" value=\"" + safeTopic + "\">" +
    "<input type=\"password\" name=\"admin_token\" placeholder=\"ADMIN_TOKEN\" size=\"28\" autocomplete=\"off\">" +
    "<button type=\"submit\">Crawl now</button>" +
    "</form>" +
    "<form method=\"POST\" action=\"/ui/rank/trigger\" autocomplete=\"off\">" +
    "<input type=\"hidden\" name=\"topic\" value=\"" + safeTopic + "\">" +
    "<input type=\"password\" name=\"admin_token\" placeholder=\"ADMIN_TOKEN\" size=\"28\" autocomplete=\"off\">" +
    "<label class=\"check\"><input type=\"checkbox\" name=\"force\" value=\"1\">Force</label>" +
    "<button type=\"submit\">Rank now</button>" +
    "</form>" +
    "<div class=\"hint\">Admin token is not stored; it is only sent with this request.</div>" +
    "</div>" +
    "<h2>Stats</h2>" +
    statsHtml +
    "<h2>Ranked Books</h2>" +
    "<ol>" + listItems + "</ol>" +
    "</body></html>"
  );
}

function buildSeedUrls(topic) {
  const encoded = encodeURIComponent(topic);
  return [
    {
      source: "doab",
      url: "https://www.doabooks.org/api/books?query=" + encoded
    },
    {
      source: "openlibrary",
      url:
        "https://openlibrary.org/search.json?q=" +
        encoded +
        "&limit=100&fields=key,title,author_name,first_publish_year,language,ebook_access"
    }
  ];
}

function parseAllowlist(text) {
  const exactHosts = new Set();
  const suffixes = [];
  const prefixes = [];
  const regexes = [];
  const regexSources = [];
  const raw = [];

  const lines = String(text || "").split("\n");
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    raw.push(line);

    if (line.startsWith("host:")) {
      exactHosts.add(line.slice(5).trim().toLowerCase());
      continue;
    }

    if (line.startsWith("suffix:")) {
      suffixes.push(line.slice(7).trim().toLowerCase());
      continue;
    }

    if (line.startsWith("prefix:")) {
      prefixes.push(line.slice(7).trim());
      continue;
    }

    if (line.startsWith("regex:")) {
      const pattern = line.slice(6).trim();
      try {
        regexes.push(new RegExp(pattern));
        regexSources.push(pattern);
      } catch (err) {
        continue;
      }
      continue;
    }

    try {
      regexes.push(new RegExp(line));
      regexSources.push(line);
    } catch (err) {
      continue;
    }
  }

  return { exactHosts, suffixes, prefixes, regexes, regexSources, raw };
}

function serializeAllowlist(parsed) {
  return {
    exact_hosts: Array.from(parsed.exactHosts),
    suffixes: parsed.suffixes,
    prefixes: parsed.prefixes,
    regexes: parsed.regexSources,
    raw: parsed.raw
  };
}

function isAllowedUrl(urlString) {
  if (!urlString) return false;
  let url;
  try {
    url = new URL(urlString);
  } catch (err) {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (ALLOWLIST.exactHosts.has(host)) return true;
  for (const suffix of ALLOWLIST.suffixes) {
    if (host.endsWith(suffix)) return true;
  }
  for (const prefix of ALLOWLIST.prefixes) {
    if (urlString.startsWith(prefix)) return true;
  }
  for (const regex of ALLOWLIST.regexes) {
    if (regex.test(urlString)) return true;
  }
  return false;
}

function isAllowedForDisplay(urlString) {
  return isAllowedUrl(urlString);
}

function detectSourceFromUrl(urlString) {
  if (!urlString) return "";
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    if (host.includes("openlibrary.org")) return "openlibrary";
    if (host.includes("doabooks.org")) return "doab";
    if (host.includes("gutenberg.org")) return "gutenberg";
  } catch (err) {
    return "";
  }
  return "";
}

function normalizeTopic(topic) {
  return String(topic || "").trim();
}

function normalizeBool(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function htmlResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function redirectResponse(pathname, params) {
  const url = new URL(pathname || "/", "https://redirect.invalid");
  if (params && typeof params === "object") {
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      const str = String(value);
      if (!str) continue;
      url.searchParams.set(key, str);
    }
  }
  return new Response(null, {
    status: 303,
    headers: { location: url.pathname + url.search }
  });
}

function requireAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return { ok: false, response: jsonResponse({ error: "ADMIN_TOKEN not configured" }, 500) };
  }

  const auth = request.headers.get("authorization") || "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = headerToken || request.headers.get("x-admin-token") || "";

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: "unauthorized" }, 401) };
}

function requireAdminToken(token, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return { ok: false, error: "ADMIN_TOKEN not configured" };
  const provided = String(token || "");
  if (provided && provided === expected) return { ok: true };
  return { ok: false, error: "unauthorized" };
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

function extractJsonArray(text) {
  if (!text) return "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start, end + 1);
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function truncateText(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(text) {
  if (!text) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

function matchFirst(text, regexes) {
  if (!text) return "";
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match && match[1]) return match[1];
  }
  return "";
}

function firstString() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    if (!value) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (item && typeof item === "object") {
          if (typeof item.value === "string" && item.value.trim()) return item.value.trim();
          if (typeof item.name === "string" && item.name.trim()) return item.name.trim();
        }
      }
    }
    if (value && typeof value === "object") {
      if (typeof value.value === "string" && value.value.trim()) return value.value.trim();
      if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    }
  }
  return "";
}

function listToString(value) {
  if (!value) return null;
  if (typeof value === "string") return cleanText(value) || null;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === "string") {
        const cleaned = cleanText(item);
        if (cleaned) parts.push(cleaned);
      } else if (item && typeof item === "object") {
        const name = cleanText(item.name || item.value || "");
        if (name) parts.push(name);
      }
    }
    return parts.length ? parts.join("; ") : null;
  }
  if (value && typeof value === "object") {
    const name = cleanText(value.name || value.value || "");
    return name || null;
  }
  return null;
}

function toYear(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const year = Math.floor(num);
  if (year < 1000 || year > 3000) return null;
  return year;
}

function extractDoabItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  if (data._embedded && Array.isArray(data._embedded.items)) return data._embedded.items;
  return [];
}

function pickUrl() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    const found = extractUrl(value);
    if (found) return found;
  }
  return "";
}

function extractUrl(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return isProbablyUrl(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    if (typeof value.url === "string" && isProbablyUrl(value.url)) return value.url;
    if (typeof value.href === "string" && isProbablyUrl(value.href)) return value.href;
    if (typeof value.link === "string" && isProbablyUrl(value.link)) return value.link;
  }
  return "";
}

function isProbablyUrl(value) {
  return typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return safeJsonParse(text, {});
}

async function readForm(request) {
  const text = await request.text();
  if (!text) return {};
  const params = new URLSearchParams(text);
  const obj = {};
  for (const [key, value] of params.entries()) {
    obj[key] = value;
  }
  return obj;
}
