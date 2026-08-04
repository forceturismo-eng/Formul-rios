/**
 * Validação de arquivo enviado.
 *
 * O `Content-Type` do multipart é escrito pelo cliente e não vale nada — quem
 * envia decide o que declarar. Por isso a conferência é em três frentes:
 *
 *   1. O tipo declarado está na whitelist?
 *   2. Os primeiros bytes do arquivo batem com esse tipo? (magic bytes)
 *   3. O tamanho cabe no que o plano permite?
 *
 * Um .exe renomeado para .pdf passa em (1) e morre em (2).
 *
 * SVG está fora da whitelist de propósito. É XML: aceita `<script>` e
 * `onload`, e servi-lo de volta ao navegador seria XSS armazenado. Se um dia
 * for necessário, entra sanitizado e servido com `Content-Disposition:
 * attachment`, nunca inline.
 */

export interface AllowedType {
  mime: string;
  extensions: string[];
  /** `null` para formatos de texto puro, que não têm assinatura. */
  magic: number[][] | null;
  label: string;
}

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { mime: 'application/pdf', extensions: ['pdf'], magic: [[0x25, 0x50, 0x44, 0x46]], label: 'PDF' },
  { mime: 'image/png', extensions: ['png'], magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], label: 'PNG' },
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], magic: [[0xff, 0xd8, 0xff]], label: 'JPEG' },
  {
    mime: 'image/gif',
    extensions: ['gif'],
    magic: [
      [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
      [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ],
    label: 'GIF',
  },
  // WEBP é um contêiner RIFF: os bytes 0-3 são "RIFF" e os 8-11, "WEBP".
  { mime: 'image/webp', extensions: ['webp'], magic: [[0x52, 0x49, 0x46, 0x46]], label: 'WebP' },
  // Os formatos do Office moderno são ZIP por dentro.
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
    label: 'Word',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
    label: 'Excel',
  },
  { mime: 'application/zip', extensions: ['zip'], magic: [[0x50, 0x4b, 0x03, 0x04]], label: 'ZIP' },
  // Os antigos .doc/.xls são contêineres OLE2.
  {
    mime: 'application/msword',
    extensions: ['doc'],
    magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    label: 'Word 97',
  },
  {
    mime: 'application/vnd.ms-excel',
    extensions: ['xls'],
    magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    label: 'Excel 97',
  },
  { mime: 'text/plain', extensions: ['txt'], magic: null, label: 'Texto' },
  { mime: 'text/csv', extensions: ['csv'], magic: null, label: 'CSV' },
];

const BY_MIME = new Map(ALLOWED_TYPES.map((t) => [t.mime, t]));

export function extensionOf(filename: string): string {
  const partes = filename.toLowerCase().split('.');
  return partes.length > 1 ? (partes.pop() as string) : '';
}

function matchesMagic(bytes: Buffer, magic: number[][]): boolean {
  return magic.some((assinatura) => assinatura.every((byte, i) => bytes[i] === byte));
}

/** Texto puro não tem assinatura: o que dá para checar é a ausência de byte nulo. */
function looksLikeText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 512).includes(0x00);
}

export interface UploadCheck {
  ok: boolean;
  reason?: string;
  /** Extensão segura, derivada do tipo real — não da que o usuário mandou. */
  safeExtension?: string;
}

export function validateUpload(params: {
  filename: string;
  declaredMime: string;
  bytes: Buffer;
  maxBytes: number;
  /** Restrição do próprio campo do formulário, quando existir. */
  acceptedMimeTypes?: string[];
}): UploadCheck {
  if (params.bytes.byteLength === 0) {
    return { ok: false, reason: 'O arquivo está vazio.' };
  }

  if (params.bytes.byteLength > params.maxBytes) {
    const limiteMb = Math.floor(params.maxBytes / (1024 * 1024));
    return { ok: false, reason: `O arquivo passa do limite de ${limiteMb} MB do seu plano.` };
  }

  const tipo = BY_MIME.get(params.declaredMime.toLowerCase().split(';')[0]?.trim() ?? '');
  if (!tipo) {
    return { ok: false, reason: 'Esse tipo de arquivo não é aceito.' };
  }

  if (params.acceptedMimeTypes && params.acceptedMimeTypes.length > 0) {
    if (!params.acceptedMimeTypes.includes(tipo.mime)) {
      return { ok: false, reason: 'Esse tipo de arquivo não é aceito neste campo.' };
    }
  }

  // A extensão precisa combinar com o tipo declarado. "relatorio.exe" enviado
  // como application/pdf morre aqui.
  const extensao = extensionOf(params.filename);
  if (extensao && !tipo.extensions.includes(extensao)) {
    return { ok: false, reason: 'A extensão do arquivo não combina com o conteúdo.' };
  }

  // E o conteúdo precisa combinar com os dois. Este é o cheque que vale.
  if (tipo.magic) {
    if (!matchesMagic(params.bytes, tipo.magic)) {
      return { ok: false, reason: 'O conteúdo do arquivo não corresponde ao tipo informado.' };
    }
    if (tipo.mime === 'image/webp') {
      const marcador = params.bytes.subarray(8, 12).toString('ascii');
      if (marcador !== 'WEBP') return { ok: false, reason: 'O conteúdo do arquivo não corresponde ao tipo informado.' };
    }
  } else if (!looksLikeText(params.bytes)) {
    return { ok: false, reason: 'O conteúdo do arquivo não corresponde ao tipo informado.' };
  }

  return { ok: true, safeExtension: tipo.extensions[0] as string };
}

/** Nome exibido ao usuário. O nome no storage é sempre aleatório. */
export function sanitizeFilename(filename: string): string {
  return (
    filename
      // Barra e contrabarra viram sublinhado: nome de arquivo não é caminho.
      .replace(/[/\\]/g, '_')
      // Caracteres de controle fora, inclusive o nulo, que trunca nomes em
      // várias camadas mais abaixo.
      //
      // O `no-control-regex` existe para pegar quem escreve caractere de
      // controle numa regex sem perceber. Aqui eles são exatamente o alvo.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 255) || 'arquivo'
  );
}

