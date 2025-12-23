const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://alkitab.sabda.org/resource.php';
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
};

const normalizeSpace = (value) =>
  value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const htmlToText = (html) => {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n');
  return cheerio.load(withBreaks).text();
};

const extractTitle = ($, lines) => {
  const rawTitle = $('h2')
    .filter((_, node) => /KJ\.\s*\d+/i.test($(node).text()))
    .first()
    .text();
  if (rawTitle) {
    return normalizeSpace(
      rawTitle.replace(/^KJ\.\s*\d+\s*-\s*/i, '').replace(/\s*>$/, '')
    );
  }

  const fallback = lines.find((line) => /^KJ\.\s*\d+\s*-/i.test(line));
  if (!fallback) {
    return '';
  }

  return normalizeSpace(
    fallback.replace(/^KJ\.\s*\d+\s*-\s*/i, '').replace(/\s*>$/, '')
  );
};

const isLabelLine = (text) => /^[A-Z][a-zA-Z\s/()]+:/.test(text);

const collectMetaBlock = (lines, label) => {
  const prefix = `${label}:`;
  const startIndex = lines.findIndex((text) => text.startsWith(prefix));
  if (startIndex === -1) {
    return null;
  }

  const block = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (i !== startIndex && isLabelLine(line)) {
      break;
    }
    if (/^\d+\.\s/.test(line)) {
      break;
    }
    block.push(line);
  }

  const combined = block.join(' ');
  return normalizeSpace(combined.replace(prefix, ''));
};

const extractLyrics = (lines) => {
  const verses = [];
  let current = null;

  lines.forEach((line) => {
    if (/^Lihat lagu ini/i.test(line)) {
      return;
    }
    if (/^\d+\.\s/.test(line)) {
      if (current) {
        verses.push(current.trim());
      }
      current = line;
      return;
    }
    if (current) {
      current += `\n${line}`;
    }
  });

  if (current) {
    verses.push(current.trim());
  }

  return verses.map(normalizeSpace);
};

const selectContentRoot = ($) => {
  const titleNode = $('h2')
    .filter((_, node) => /KJ\.\s*\d+/i.test($(node).text()))
    .first();
  if (titleNode.length) {
    return titleNode.parent();
  }

  const selectors = [
    '#content',
    '#content-right',
    '#content_body',
    '#right',
    '.resource_text',
    '.resource',
    'body'
  ];

  for (const selector of selectors) {
    const node = $(selector).first();
    if (!node.length) {
      continue;
    }
    const text = normalizeSpace(node.text());
    if (text.includes('KJ.') || text.includes('Syair') || text.includes('Lagu')) {
      return node;
    }
  }

  return $('body');
};

const extractLines = ($, root) => {
  const html = root.clone().find('script,style').remove().end().html() || '';
  const text = htmlToText(html);
  const lines = text
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter((line) => line.length > 0);
  const titleIndex = lines.findIndex((line) => /^KJ\.\s*\d+\s*-/i.test(line));
  if (titleIndex !== -1) {
    return lines.slice(titleIndex);
  }
  return lines;
};

const parseSong = async (id) => {
  const { data } = await axios.get(BASE_URL, {
    params: {
      topic: id,
      res: 'kidung_jemaat'
    },
    headers: DEFAULT_HEADERS
  });

  const $ = cheerio.load(data);
  const root = selectContentRoot($);
  const lines = extractLines($, root);
  const title = extractTitle($, lines);
  const contentStart = lines.findIndex((line) =>
    /^KJ\.\s*\d+\s*-/i.test(line)
  );
  const contentLines = contentStart === -1 ? lines : lines.slice(contentStart + 1);

  return {
    id,
    title,
    syair: collectMetaBlock(contentLines, 'Syair'),
    lagu: collectMetaBlock(contentLines, 'Lagu'),
    lyrics: extractLyrics(contentLines)
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const startId = Number(process.argv[2] || '1');
  const endId = Number(process.argv[3] || '478');
  const outputDir = process.argv[4] || 'kj-json';

  if (Number.isNaN(startId) || Number.isNaN(endId) || startId < 1 || endId < 1) {
    throw new Error(
      'Start/end id harus angka positif. Contoh: node scripts/parse-kidung-jemaat.js 1 478'
    );
  }

  if (startId > endId) {
    throw new Error('Start id harus <= end id.');
  }

  fs.mkdirSync(outputDir, { recursive: true });

  for (let id = startId; id <= endId; id += 1) {
    try {
      const song = await parseSong(id);
      const filepath = path.join(outputDir, `kj_${id}.json`);
      fs.writeFileSync(filepath, `${JSON.stringify(song, null, 2)}\n`);
      console.log(`Saved ${filepath}`);
    } catch (error) {
      console.error(`Failed ${id}: ${error.message}`);
    }

    await sleep(300);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
