/**
 * Silent Send - Document Scanner
 *
 * Scans uploaded documents for PPI and substitutes/redacts before
 * the file reaches the AI service.
 *
 * Supported formats:
 * - PDF: Extract text, scan for PPI, create sanitized plaintext version
 *   (PDFs can't be reliably edited in-place without breaking layout)
 * - DOCX: Parse XML, find-replace text, repackage ZIP (layout preserved)
 * - XLSX: Parse cells, find-replace values, repackage (formatting preserved)
 * - TXT/CSV/JSON/MD: Direct string replacement
 *
 * Modes:
 * - Silent: substitute and upload (default for text files)
 * - Preview: show PPI findings, let user confirm before upload (default for PDF/DOCX/XLSX)
 *
 * Integration:
 * - The fetch interceptor in content.js detects multipart/form-data uploads
 * - Calls DocumentScanner.processUpload() which returns the modified file
 * - Badge count includes document substitutions
 */

const DocumentScanner = {
  /**
   * Process a file upload. Detects format and applies appropriate strategy.
   *
   * @param {File|Blob} file - the file being uploaded
   * @param {string} filename - original filename
   * @param {Function} substituteAll - the substituteAll function from content.js
   * @param {Object} options - { previewMode: boolean }
   * @returns {{ file: Blob, filename: string, replacements: Array, preview?: Object, skipped?: boolean }}
   */
  async processUpload(file, filename, substituteAll, options = {}) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const type = this._detectType(ext, file.type);

    switch (type) {
      case 'text':
        return this._processText(file, filename, substituteAll);
      case 'pdf':
        return this._processPDF(file, filename, substituteAll, options);
      case 'docx':
        return this._processDOCX(file, filename, substituteAll, options);
      case 'xlsx':
        return this._processXLSX(file, filename, substituteAll, options);
      default:
        // Unsupported format — pass through unchanged
        return { file, filename, replacements: [], skipped: true };
    }
  },

  /**
   * Plain text files: direct string replacement.
   */
  async _processText(file, filename, substituteAll) {
    const text = await file.text();
    const result = substituteAll(text);

    if (!result.modified) {
      return { file, filename, replacements: [] };
    }

    const newBlob = new Blob([result.text], { type: file.type || 'text/plain' });
    return {
      file: newBlob,
      filename,
      replacements: result.replacements,
    };
  },

  /**
   * PDF: extract text, scan for PPI, create sanitized text file.
   * PDFs can't be reliably edited in-place, so we extract text,
   * substitute PPI, and send the clean text instead.
   */
  async _processPDF(file, filename, substituteAll, options) {
    const text = await this._extractPDFText(file);
    if (!text || text.trim().length === 0) {
      // Scanned PDF or image-only — can't extract text
      return {
        file,
        filename,
        replacements: [],
        skipped: true,
        reason: 'No extractable text in PDF (may be scanned/image-only)',
      };
    }

    const result = substituteAll(text);

    if (!result.modified && !options.previewMode) {
      return { file, filename, replacements: [] };
    }

    // Build preview data
    const preview = {
      originalLength: text.length,
      substitutedLength: result.text.length,
      replacementCount: result.replacements.length,
      replacements: result.replacements.slice(0, 20), // limit preview
      format: 'pdf',
      note: 'PDF will be converted to plain text for upload (layout not preserved)',
    };

    if (options.previewMode) {
      return { file, filename, replacements: result.replacements, preview };
    }

    // Create sanitized text file
    const sanitizedBlob = new Blob([result.text], { type: 'text/plain' });
    const sanitizedFilename = filename.replace(/\.pdf$/i, '.txt');

    return {
      file: sanitizedBlob,
      filename: sanitizedFilename,
      replacements: result.replacements,
      preview,
      convertedFrom: 'pdf',
    };
  },

  /**
   * DOCX: parse the ZIP, find-replace text in XML content, repackage.
   * Layout, formatting, images, and styles are preserved.
   */
  async _processDOCX(file, filename, substituteAll, options) {
    try {
      const zip = await this._readZip(file);
      let totalReplacements = [];
      let modified = false;

      // DOCX text is in word/document.xml (main body), word/header*.xml,
      // word/footer*.xml, and word/comments.xml
      const textFiles = Object.keys(zip.files).filter(name =>
        /^word\/(document|header\d*|footer\d*|comments|endnotes|footnotes)\.xml$/.test(name)
      );

      for (const xmlPath of textFiles) {
        const xmlContent = await zip.files[xmlPath].async('string');

        // Extract text runs from XML, substitute, and rebuild
        const { xml: newXml, replacements } = this._substituteInXML(xmlContent, substituteAll);

        if (replacements.length > 0) {
          zip.files[xmlPath] = { data: newXml, isText: true };
          totalReplacements.push(...replacements);
          modified = true;
        }
      }

      if (!modified && !options.previewMode) {
        return { file, filename, replacements: [] };
      }

      const preview = {
        replacementCount: totalReplacements.length,
        replacements: totalReplacements.slice(0, 20),
        format: 'docx',
        note: 'Text in document body, headers, and footers will be substituted. Formatting preserved.',
      };

      if (options.previewMode) {
        return { file, filename, replacements: totalReplacements, preview };
      }

      // Repackage the ZIP
      const newBlob = await this._writeZip(zip);
      return {
        file: newBlob,
        filename,
        replacements: totalReplacements,
        preview,
      };
    } catch (e) {
      console.warn('[Silent Send] DOCX processing failed:', e);
      return { file, filename, replacements: [], skipped: true, reason: e.message };
    }
  },

  /**
   * XLSX: parse the ZIP, find-replace text in shared strings and sheet cells.
   */
  async _processXLSX(file, filename, substituteAll, options) {
    try {
      const zip = await this._readZip(file);
      let totalReplacements = [];
      let modified = false;

      // XLSX stores shared strings in xl/sharedStrings.xml
      // and inline strings in xl/worksheets/sheet*.xml
      const targetFiles = Object.keys(zip.files).filter(name =>
        name === 'xl/sharedStrings.xml' ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
      );

      for (const xmlPath of targetFiles) {
        const xmlContent = await zip.files[xmlPath].async('string');
        const { xml: newXml, replacements } = this._substituteInXML(xmlContent, substituteAll);

        if (replacements.length > 0) {
          zip.files[xmlPath] = { data: newXml, isText: true };
          totalReplacements.push(...replacements);
          modified = true;
        }
      }

      if (!modified && !options.previewMode) {
        return { file, filename, replacements: [] };
      }

      const preview = {
        replacementCount: totalReplacements.length,
        replacements: totalReplacements.slice(0, 20),
        format: 'xlsx',
        note: 'Cell values and shared strings will be substituted. Formatting and formulas preserved.',
      };

      if (options.previewMode) {
        return { file, filename, replacements: totalReplacements, preview };
      }

      const newBlob = await this._writeZip(zip);
      return {
        file: newBlob,
        filename,
        replacements: totalReplacements,
        preview,
      };
    } catch (e) {
      console.warn('[Silent Send] XLSX processing failed:', e);
      return { file, filename, replacements: [], skipped: true, reason: e.message };
    }
  },

  // ----------------------------------------------------------------
  // PDF text extraction (no external libraries)
  //
  // Parses PDF content streams to extract text. Handles the common
  // text operators (Tj, TJ, ', "). Doesn't handle every PDF edge
  // case but works for most text-based PDFs.
  // ----------------------------------------------------------------

  async _extractPDFText(file) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const str = new TextDecoder('latin1').decode(bytes);

      // Find all stream...endstream blocks
      const texts = [];
      const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
      let match;

      while ((match = streamRegex.exec(str)) !== null) {
        const streamData = match[1];

        // Try to decompress if FlateDecode
        let content = streamData;
        const filterMatch = str.slice(Math.max(0, match.index - 200), match.index)
          .match(/\/Filter\s*\/FlateDecode/);

        if (filterMatch) {
          try {
            const compressed = new Uint8Array(
              [...streamData].map(c => c.charCodeAt(0))
            );
            const decompressed = this._inflateSync(compressed);
            if (decompressed) {
              content = new TextDecoder('latin1').decode(decompressed);
            }
          } catch { /* use raw */ }
        }

        // Extract text from PDF operators
        const extracted = this._extractTextFromOperators(content);
        if (extracted) texts.push(extracted);
      }

      return texts.join('\n').trim();
    } catch (e) {
      console.warn('[Silent Send] PDF text extraction failed:', e);
      return '';
    }
  },

  /**
   * Extract text from PDF content stream operators.
   * Handles Tj (show string), TJ (show array), ' and " (next line + show).
   */
  _extractTextFromOperators(content) {
    const parts = [];

    // Match string operands: (text) Tj, [(text) ...] TJ
    // Tj operator: (string) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(content)) !== null) {
      parts.push(this._decodePDFString(m[1]));
    }

    // TJ operator: [(string) num (string) ...] TJ
    const tjArrayRegex = /\[((?:[^[\]]*?))\]\s*TJ/g;
    while ((m = tjArrayRegex.exec(content)) !== null) {
      const inner = m[1];
      const stringRegex = /\(([^)]*)\)/g;
      let s;
      while ((s = stringRegex.exec(inner)) !== null) {
        parts.push(this._decodePDFString(s[1]));
      }
    }

    // ' operator: (string) '
    const singleQuoteRegex = /\(([^)]*)\)\s*'/g;
    while ((m = singleQuoteRegex.exec(content)) !== null) {
      parts.push('\n' + this._decodePDFString(m[1]));
    }

    return parts.join('');
  },

  /**
   * Decode PDF string escapes.
   */
  _decodePDFString(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\([()])/g, '$1')
      .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  },

  /**
   * Simple DEFLATE decompression using DecompressionStream API.
   * Returns null if not available or decompression fails.
   */
  async _inflateSync(data) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      writer.write(data);
      writer.close();

      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch {
      return null;
    }
  },

  // ----------------------------------------------------------------
  // ZIP read/write (no external libraries)
  //
  // Minimal ZIP parser for DOCX/XLSX. These are standard ZIP files
  // containing XML. We only need to read/write text entries.
  // ----------------------------------------------------------------

  async _readZip(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const files = {};

    // Find end of central directory record
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
          bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

    const view = new DataView(buffer);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);

    // Read central directory entries
    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;

      const compMethod = view.getUint16(offset + 10, true);
      const compSize = view.getUint32(offset + 20, true);
      const uncompSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);

      const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLen));

      // Read from local file header
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawData = bytes.slice(dataOffset, dataOffset + compSize);

      files[name] = {
        compMethod,
        compSize,
        uncompSize,
        rawData,
        async async(type) {
          let data = this.rawData;
          if (this.compMethod === 8) {
            // Deflate compressed
            data = await DocumentScanner._inflateSync(data);
            if (!data) throw new Error('Decompression failed for ' + name);
          }
          if (type === 'string') {
            return new TextDecoder().decode(data);
          }
          return data;
        },
      };

      offset += 46 + nameLen + extraLen + commentLen;
    }

    return { files, _originalBuffer: buffer, _originalBytes: bytes };
  },

  async _writeZip(zip) {
    // Rebuild ZIP with modified entries
    // For simplicity: store all modified entries uncompressed,
    // copy unmodified entries as-is from the original buffer
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const [name, entry] of Object.entries(zip.files)) {
      const nameBytes = new TextEncoder().encode(name);
      let data;

      if (entry.isText && entry.data) {
        // Modified entry — store uncompressed
        data = new TextEncoder().encode(entry.data);
      } else if (entry.rawData) {
        // Unmodified — keep original compression
        data = entry.rawData;
      } else {
        continue;
      }

      const isStored = entry.isText || entry.compMethod === 0;
      const compMethod = isStored ? 0 : entry.compMethod;
      const compSize = data.length;
      const uncompSize = isStored ? data.length : (entry.uncompSize || data.length);

      // Local file header
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lhView = new DataView(localHeader.buffer);
      lhView.setUint32(0, 0x04034b50, true); // signature
      lhView.setUint16(4, 20, true); // version needed
      lhView.setUint16(8, compMethod, true);
      lhView.setUint32(18, compSize, true);
      lhView.setUint32(22, uncompSize, true);
      lhView.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);

      // Central directory entry
      const cdEntry = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdEntry.buffer);
      cdView.setUint32(0, 0x02014b50, true);
      cdView.setUint16(4, 20, true); // version made by
      cdView.setUint16(6, 20, true); // version needed
      cdView.setUint16(10, compMethod, true);
      cdView.setUint32(20, compSize, true);
      cdView.setUint32(24, uncompSize, true);
      cdView.setUint16(28, nameBytes.length, true);
      cdView.setUint32(42, offset, true); // local header offset
      cdEntry.set(nameBytes, 46);

      centralDir.push(cdEntry);
      parts.push(localHeader, data);
      offset += localHeader.length + data.length;
    }

    // End of central directory
    const cdStart = offset;
    let cdSize = 0;
    for (const cd of centralDir) {
      parts.push(cd);
      cdSize += cd.length;
    }

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, centralDir.length, true);
    eocdView.setUint16(10, centralDir.length, true);
    eocdView.setUint32(12, cdSize, true);
    eocdView.setUint32(16, cdStart, true);
    parts.push(eocd);

    return new Blob(parts, { type: 'application/octet-stream' });
  },

  // ----------------------------------------------------------------
  // XML text substitution (for DOCX/XLSX)
  //
  // Finds text content within XML elements and applies substitution.
  // Preserves all XML tags and attributes unchanged.
  // ----------------------------------------------------------------

  _substituteInXML(xml, substituteAll) {
    const allReplacements = [];

    // Replace text between XML tags, preserving the tags themselves
    // This handles <w:t>text</w:t> in DOCX and <t>text</t> in XLSX
    const newXml = xml.replace(/>([^<]+)</g, (match, textContent) => {
      // Skip very short or whitespace-only content
      if (!textContent || textContent.trim().length < 2) return match;

      const result = substituteAll(textContent);
      if (result.modified) {
        allReplacements.push(...result.replacements);
        return '>' + result.text + '<';
      }
      return match;
    });

    return { xml: newXml, replacements: allReplacements };
  },

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  _detectType(ext, mimeType) {
    // By extension
    const textExts = new Set(['txt', 'csv', 'tsv', 'json', 'md', 'markdown',
      'log', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html',
      'htm', 'css', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
      'h', 'hpp', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'r', 'swift',
      'kt', 'scala', 'pl', 'php', 'lua', 'vim', 'env', 'gitignore']);

    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx') return 'xlsx';
    if (textExts.has(ext)) return 'text';

    // By MIME type
    if (mimeType?.includes('pdf')) return 'pdf';
    if (mimeType?.includes('wordprocessingml')) return 'docx';
    if (mimeType?.includes('spreadsheetml')) return 'xlsx';
    if (mimeType?.startsWith('text/')) return 'text';
    if (mimeType?.includes('json') || mimeType?.includes('xml')) return 'text';

    return 'unknown';
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.DocumentScanner = DocumentScanner;
}

export default DocumentScanner;
