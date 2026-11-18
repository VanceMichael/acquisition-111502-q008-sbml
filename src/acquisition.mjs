// 自动接入编排：领取授权来源入口，按交付索引读取 roots/resources，
// 所有自动取得的依赖都保留真实原文收件，再对 SBML 根入口做结构化解释。
// 不执行交付件，不访问冻结 origin 之外的主机。

import { retrieve } from './transport.mjs';
import { interpretSbml } from './sbml.mjs';
import { summarize } from './summary.mjs';
import { XmlParser } from './xml.mjs';

function isDeliveryIndex(value) {
  return value && typeof value === 'object' && typeof value.deliveryId === 'string' && Array.isArray(value.roots);
}

function asUrl(href, base) {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export async function acquire({ archive, collectionId, entry, allowedOrigin, options = {} }) {
  if (typeof entry !== 'string' || !entry) {
    throw Object.assign(new Error('missing_entry'), { status: 400 });
  }
  let entryUrl;
  try {
    entryUrl = new URL(entry);
  } catch {
    throw Object.assign(new Error('invalid_entry_url'), { status: 400 });
  }
  if (entryUrl.origin !== allowedOrigin || entryUrl.username || entryUrl.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }

  const fetchOne = async url => {
    const fetched = await retrieve(url.href, allowedOrigin);
    const receipt = await archive.receive({
      collectionId,
      sourceKey: url.href,
      revision: fetched.revision,
      mediaType: fetched.mediaType,
      bytes: fetched.bytes,
      summary: summarize(fetched.bytes, fetched.mediaType)
    });
    return { url, fetched, receipt };
  };

  // 入口本身始终是一份真实原文收件。
  const entryPayload = await fetchOne(entryUrl);
  const receipts = [entryPayload.receipt];
  const issues = [];
  let index = null;
  const contentType = entryPayload.fetched.mediaType || '';
  if (contentType.includes('application/json')) {
    try {
      index = JSON.parse(entryPayload.fetched.bytes.toString('utf8'));
    } catch (error) {
      issues.push({
        reason: 'delivery_index_unparseable',
        location: XmlParser.formatLocation({ byteStart: 0, byteEnd: entryPayload.fetched.bytes.length, line: 1, column: 1 }),
        receiptId: entryPayload.receipt.receiptId,
        detail: error.message
      });
    }
  }

  const queued = [];
  if (isDeliveryIndex(index)) {
    for (const root of index.roots) {
      const url = asUrl(root.href, entryUrl);
      if (url) queued.push({ url, role: 'root', name: root.name ?? null });
      else issues.push({ reason: 'delivery_root_href_invalid', location: 'jsonPointer:/roots', receiptId: entryPayload.receipt.receiptId, href: String(root.href) });
    }
    for (const resource of index.resources) {
      const url = asUrl(resource.href, entryUrl);
      if (url) queued.push({ url, role: 'resource', name: resource.name ?? null });
      else issues.push({ reason: 'delivery_resource_href_invalid', location: 'jsonPointer:/resources', receiptId: entryPayload.receipt.receiptId, href: String(resource.href) });
    }
  } else {
    // 入口不是交付索引时，把入口自身当作唯一根入口处理。
    queued.push({ url: entryUrl, role: 'root', name: null, receipt: entryPayload.receipt, bytes: entryPayload.fetched.bytes });
  }

  const seen = new Set([entryUrl.href]);
  const rootPayloads = [];
  for (const item of queued) {
    if (seen.has(item.url.href)) {
      if (item.role === 'root' && item.url.href === entryUrl.href) rootPayloads.push({ ...item, receipt: entryPayload.receipt, bytes: entryPayload.fetched.bytes });
      continue;
    }
    seen.add(item.url.href);
    try {
      const payload = await fetchOne(item.url);
      receipts.push(payload.receipt);
      if (item.role === 'root') rootPayloads.push({ ...item, receipt: payload.receipt, bytes: payload.fetched.bytes });
    } catch (error) {
      issues.push({
        reason: 'dependency_fetch_failed',
        location: `url:${item.url.href}`,
        receiptId: null,
        role: item.role,
        detail: error.message
      });
    }
  }

  for (const issue of issues) await archive.addIssue(collectionId, issue);

  // 只解释 roots；resources 仅保留原文收件，不假称已解释。
  for (const root of rootPayloads) {
    const head = root.bytes.subarray(0, 4096).toString('utf8').trimStart();
    if (!head.startsWith('<')) {
      await archive.addIssue(collectionId, {
        reason: 'root_format_unsupported',
        location: XmlParser.formatLocation({ byteStart: 0, byteEnd: Math.min(root.bytes.length, 64), line: 1, column: 1 }),
        receiptId: root.receipt.receiptId
      });
      continue;
    }
    const interpretation = interpretSbml(root.bytes, { receiptId: root.receipt.receiptId, sourceKey: root.url.href });
    for (const record of interpretation.records) {
      try {
        await archive.addRecord(collectionId, record);
      } catch (error) {
        // 同键不同内容不覆盖已归档视图，登记为未决冲突，保留双方出处可回查。
        if (error.status !== 409) throw error;
        await archive.addIssue(collectionId, {
          reason: 'record_identity_conflict',
          location: record.provenance[0].location,
          receiptId: root.receipt.receiptId,
          kind: record.kind,
          key: record.key
        });
      }
    }
    for (const issue of interpretation.issues) await archive.addIssue(collectionId, issue);
  }

  return {
    collectionId,
    receiptIds: [...new Set(receipts.map(receipt => receipt.receiptId))],
    options
  };
}
