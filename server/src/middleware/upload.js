// server/src/middleware/upload.js
// Files are held in memory only long enough to be validated and sent to Supabase Storage;
// never written to local disk. Declared MIME type, extension and the file's real
// magic bytes must all agree.
const multer = require('multer');
const env = require('../config/env');

const DOCS = {
  'application/pdf': { ext: 'pdf', check: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  'image/jpeg': { ext: 'jpg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
};
const IMAGES = {
  'image/jpeg': DOCS['image/jpeg'],
  'image/png': DOCS['image/png'],
  'image/webp': { ext: 'webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const EXT_OK = { 'application/pdf': ['pdf'], 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };

function build(allowed, maxBytes, fieldName) {
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
    fileFilter(req, file, cb) {
      const ext = (file.originalname.split('.').pop() || '').toLowerCase();
      if (!allowed[file.mimetype] || !EXT_OK[file.mimetype].includes(ext)) return cb(new Error('UNSUPPORTED_FILE_TYPE'));
      cb(null, true);
    },
  }).single(fieldName);

  const verify = (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'No file was uploaded.' } });
    const spec = allowed[req.file.mimetype];
    if (!req.file.size || !spec.check(req.file.buffer)) {
      return res.status(400).json({ error: { code: 'INVALID_FILE_CONTENT', message: 'The file content does not match its type.' } });
    }
    req.fileExt = spec.ext;
    next();
  };
  return [uploader, verify];
}

// Private documents: payment proof, quote attachments (PDF/JPG/PNG).
const documentUpload = (field) => build(DOCS, env.uploadMaxBytes, field);
// Product images (JPG/PNG/WebP).
const imageUpload = (field) => build(IMAGES, env.productImageMaxBytes, field);

module.exports = { documentUpload, imageUpload };
