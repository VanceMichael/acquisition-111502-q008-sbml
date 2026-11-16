// 领取编排：从授权来源领取入口与依赖，登记真实收件，然后对 SBML 字节做声明解释。
// 入口领取失败按错误向上抛；单个依赖失败只记为问题，不影响其余资料入库。

import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { interpretSbml } from './sbml.mjs';

const MAX_DOCUMENTS = 64;
const MAX_DELIVERY_DEPTH = 4;

function parseDelivery(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && value.deliveryId && Array.isArray(value.roots)) return value;
  } catch {}
  return null;
}

function looksLikeXml(bytes, mediaType) {
  if (/xml|sbml/i.test(mediaType)) return true;
  const head = bytes.subarray(0, 64).toString('utf8');
  return /^(?:\uFEFF|\s)*</.test(head);
}

export async function acquire({ archive, collectionId, entry, allowedOrigin }) {
  const receiptIds = [];
  const records = [];
  const issues = [];
  const visited = new Set();

  async function receive(url) {
    const result = await retrieve(url, allowedOrigin);
    const receipt = await archive.receive({
      collectionId, sourceKey: url, revision: result.revision,
      mediaType: result.mediaType, bytes: result.bytes,
      summary: summarize(result.bytes, result.mediaType)
    });
    receiptIds.push(receipt.receiptId);
    return { ...result, receiptId: receipt.receiptId };
  }

  async function process(url, depth, parent) {
    if (visited.has(url)) return;
    if (visited.size >= MAX_DOCUMENTS) {
      issues.push({ reason: 'document_limit_reached', location: parent ? parent.pointer : '/', ...(parent ? { receiptId: parent.receiptId } : {}), detail: { href: url } });
      return;
    }
    visited.add(url);
    const document = await receive(url);
    const delivery = parseDelivery(document.bytes);
    if (delivery) {
      if (depth >= MAX_DELIVERY_DEPTH) {
        issues.push({ reason: 'delivery_nesting_too_deep', location: '/', receiptId: document.receiptId });
        return;
      }
      for (let index = 0; index < delivery.roots.length; index += 1) {
        const pointer = `/roots/${index}`;
        const href = delivery.roots[index]?.href;
        if (typeof href !== 'string' || !href) {
          issues.push({ reason: 'invalid_root_reference', location: pointer, receiptId: document.receiptId });
          continue;
        }
        let resolved;
        try {
          resolved = new URL(href, url).toString();
        } catch {
          issues.push({ reason: 'invalid_root_reference', location: pointer, receiptId: document.receiptId, detail: { href } });
          continue;
        }
        try {
          await process(resolved, depth + 1, { pointer, receiptId: document.receiptId });
        } catch (error) {
          issues.push({ reason: 'resource_unavailable', location: pointer, receiptId: document.receiptId, detail: { href: resolved, error: error.message } });
        }
      }
      return;
    }
    if (!looksLikeXml(document.bytes, document.mediaType)) {
      issues.push({ reason: 'unsupported_content', location: 'bytes:0', receiptId: document.receiptId, detail: { mediaType: document.mediaType } });
      return;
    }
    const interpreted = interpretSbml(document.bytes, document.receiptId);
    records.push(...interpreted.records);
    issues.push(...interpreted.issues);
  }

  await process(entry, 0, null);
  await archive.applyInterpretation(collectionId, { records, issues });
  return { collectionId, receiptIds };
}
