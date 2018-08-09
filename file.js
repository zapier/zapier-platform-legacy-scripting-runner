// A module handling file upload, file fields, and file scripting.

const fs = require('fs');
const os = require('os');
const path = require('path');
const urllib = require('url');

const _ = require('lodash');
const JSZip = require('jszip');
const request = require('request');

const markFileFieldsInBundle = (bundle, inputFields) => {
  const fileFieldKeys = inputFields
    .filter(field => field.type === 'file')
    .map(field => field.key);

  if (fileFieldKeys.length > 0) {
    // Add it to bundle so that functions that don't have access to app
    // definition, such as bundleConverter, knows which fields are files
    bundle._fileFieldKeys = fileFieldKeys;
  }
};

const hasFileFields = bundle => {
  return bundle._fileFieldKeys && bundle._fileFieldKeys.length > 0;
};

const isFileField = (fieldKey, bundle) => {
  if (!bundle._fileFieldKeys) {
    return false;
  }
  return bundle._fileFieldKeys.indexOf(fieldKey) >= 0;
};

const splitUrls = str => {
  // TODO: Make it more like WB
  const parts = str.split(',');
  return parts.map(s => s.trim()).filter(s => {
    if (!s) {
      return false;
    }
    const parsed = urllib.parse(s);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname
    );
  });
};

const extractFilenameFromContent = content =>
  content.substr(0, 12).replace('.txt', '') + ' ... .txt';

const extractFilenameFromContentDisposition = value => {
  let filename = '';

  // Follows RFC 6266
  const patterns = [
    // Example: "attachment; filename*= UTF-8''%e2%82%ac%20rates"
    /filename\*\s*=\s*[a-z0-9_-]+''(.*)(?:;|$)/gi,

    // Example: 'INLINE; FILENAME= "an example.html"'
    /filename\s*=\s*"([^"]+)"/gi,

    // Example: 'Attachment; filename=example.html'
    /filename\s*=\s*([^ ]+)/gi
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) {
      filename = match[1];
      break;
    }
  }

  if (filename) {
    filename = decodeURIComponent(filename);
  }

  return filename;
};

const extractFilenameFromUrl = url => {
  const pathname = urllib.parse(url).pathname;
  if (pathname) {
    const parts = pathname.split('/');
    return parts[parts.length - 1] || '';
  }
  return '';
};

const formatFilenameFromUrls = urls =>
  urls
    .map(extractFilenameFromUrl)
    .filter(n => n)
    .join(' ')
    .substr(0, 240) + '.zip';

const fetchFileMeta = url =>
  new Promise((resolve, reject) => {
    request({ method: 'HEAD', url }, (err, res) => {
      if (err) {
        reject(err);
      } else {
        const disposition = res.headers['content-disposition'];
        const filename = disposition
          ? extractFilenameFromContentDisposition(disposition)
          : extractFilenameFromUrl(res.request.uri.href);
        const contentType =
          res.headers['content-type'] || 'application/octet-stream';
        resolve({ filename, contentType });
      }
    });
  });

const streamZipFromUrls = urls =>
  new Promise((resolve, reject) => {
    const zip = new JSZip();
    urls.forEach((url, i) => {
      const name = extractFilenameFromUrl(url) || `unnamed.file.${i}`;
      zip.file(name, request(url));
    });
    try {
      const zipPath = path.join(os.tmpdir(), 'temp.zip');
      zip
        .generateNodeStream({ streamFiles: true })
        .pipe(fs.createWriteStream(zipPath))
        .on('finish', () => {
          const readStream = fs.createReadStream(zipPath);
          readStream.on('close', () => {
            fs.unlinkSync(zipPath);
          });
          resolve(readStream);
        });
    } catch (err) {
      reject(err);
    }
  });

const ContentBackedLazyFile = (content, fileMeta) => {
  const meta = async () => {
    return {
      filename: fileMeta.filename || extractFilenameFromContent(content),
      contentType: fileMeta.contentType || 'text/plain'
    };
  };

  // readStream is only used by FormData.append(). And FormData.append(key,
  // data, options) accepts a string for its `data` argument, so instead of
  // trying to make the string a readable stream, we can just return the
  // string here.
  const readStream = async () => content;

  return { meta, readStream };
};

const SingleUrlBackedLazyFile = (url, fileMeta) => {
  const hasCompleteMeta = fileMeta.filename && fileMeta.contentType;

  let cachedFileMeta;
  const fetchFileMetaWithCache = async fileUrl => {
    // Cache fileMeta so when we call LazyFile.meta, we don't need to send an
    // HTTP request again
    if (cachedFileMeta) {
      return cachedFileMeta;
    }
    const fm = await fetchFileMeta(fileUrl);
    cachedFileMeta = fm;
    return fm;
  };

  const meta = async () => {
    if (hasCompleteMeta) {
      return fileMeta;
    }
    const fm = fetchFileMetaWithCache(url);
    return _.extend(fm, fileMeta);
  };
  const readStream = async () => request(url);

  return { meta, readStream };
};

const MultipleUrlsBackedLazyFile = (urls, fileMeta) => {
  const meta = async () => {
    return {
      filename: fileMeta.filename || formatFilenameFromUrls(urls),
      contentType: fileMeta.contentType || 'application/zip'
    };
  };
  const readStream = async () => await streamZipFromUrls(urls);
  return { meta, readStream };
};

const LazyFile = (urlOrContent, fileMeta, options) => {
  fileMeta = fileMeta || {};
  options = options || {};

  const urls = options.dontLoadUrls ? [] : splitUrls(urlOrContent);
  if (urls.length === 0) {
    return ContentBackedLazyFile(urlOrContent, fileMeta);
  } else if (urls.length === 1) {
    return SingleUrlBackedLazyFile(urls[0], fileMeta);
  }
  return MultipleUrlsBackedLazyFile(urls, fileMeta);
};

module.exports = {
  markFileFieldsInBundle,
  hasFileFields,
  isFileField,
  LazyFile
};
