// server/src/services/files.js: private file storage (payment proofs, quote attachments) and public product images.
const crypto = require('crypto');
const supabase = require('../db/supabase');
const env = require('../config/env');

const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

// Stores the object in the PRIVATE bucket and records it. Rolls the object back if the row cannot be written.
async function storePrivate({ buffer, mime, ext, originalName, ownerId, purpose, folder, quoteRequestId = null }) {
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from(env.storageBucket).upload(path, buffer, { contentType: mime, upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await supabase.from('files').insert({
    owner_id: ownerId, bucket_path: path, original_name: safeName(originalName), mime_type: mime,
    size_bytes: buffer.length, purpose, quote_request_id: quoteRequestId,
  }).select().single();
  if (error) { await supabase.storage.from(env.storageBucket).remove([path]); throw error; }
  return data;
}

async function removePrivate(fileRow) {
  if (!fileRow) return;
  await supabase.storage.from(env.storageBucket).remove([fileRow.bucket_path]).catch(() => {});
  await supabase.from('files').delete().eq('id', fileRow.id);
}

async function signedUrl(path, seconds = 300) {
  const { data, error } = await supabase.storage.from(env.storageBucket).createSignedUrl(path, seconds);
  if (error) throw error;
  return data.signedUrl;
}

// Product images live in a PUBLIC bucket (they are shown to everyone on the storefront).
async function storeProductImage({ productId, buffer, mime, ext }) {
  const path = `products/${productId}/${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from(env.productBucket).upload(path, buffer, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (up.error) throw up.error;
  const { data } = supabase.storage.from(env.productBucket).getPublicUrl(path);
  return { path, url: data.publicUrl };
}
async function removeProductImage(path) {
  if (path) await supabase.storage.from(env.productBucket).remove([path]).catch(() => {});
}

module.exports = { storePrivate, removePrivate, signedUrl, storeProductImage, removeProductImage };
