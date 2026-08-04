import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TYPES,
  extensionOf,
  sanitizeFilename,
  validateUpload,
} from '../../apps/api/src/storage/upload-validation.js';
import { buildObjectKey, keyBelongsTo } from '../../apps/api/src/storage/provider.js';

/**
 * Validação de upload.
 *
 * O `Content-Type` do multipart é escrito por quem envia. Estes testes cobrem
 * exatamente os casos em que ele mente.
 */

const MB = 1024 * 1024;

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.from('1.7 conteudo')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x22)]);
// ELF: um executável Linux. É o que um atacante renomeia para .pdf.
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 0x00)]);
const TEXTO = Buffer.from('nome;email\nMaria;maria@exemplo.com.br\n', 'utf8');

const base = { maxBytes: 25 * MB };

describe('tipos aceitos', () => {
  it('aceita PDF, PNG, JPEG e CSV legítimos', () => {
    expect(validateUpload({ ...base, filename: 'contrato.pdf', declaredMime: 'application/pdf', bytes: PDF }).ok).toBe(true);
    expect(validateUpload({ ...base, filename: 'foto.png', declaredMime: 'image/png', bytes: PNG }).ok).toBe(true);
    expect(validateUpload({ ...base, filename: 'foto.jpg', declaredMime: 'image/jpeg', bytes: JPEG }).ok).toBe(true);
    expect(validateUpload({ ...base, filename: 'lista.csv', declaredMime: 'text/csv', bytes: TEXTO }).ok).toBe(true);
  });

  it('aceita Content-Type com charset', () => {
    const check = validateUpload({ ...base, filename: 'a.csv', declaredMime: 'text/csv; charset=utf-8', bytes: TEXTO });
    expect(check.ok).toBe(true);
  });

  it('recusa tipo fora da whitelist', () => {
    for (const mime of ['application/x-msdownload', 'application/x-sh', 'text/html', 'application/javascript']) {
      expect(validateUpload({ ...base, filename: 'a.bin', declaredMime: mime, bytes: PDF }).ok, mime).toBe(false);
    }
  });

  it('não aceita SVG', () => {
    // SVG é XML e aceita <script>. Servi-lo de volta seria XSS armazenado.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(validateUpload({ ...base, filename: 'x.svg', declaredMime: 'image/svg+xml', bytes: svg }).ok).toBe(false);
    expect(ALLOWED_TYPES.some((t) => t.mime.includes('svg'))).toBe(false);
  });
});

describe('conteúdo mentindo sobre o tipo', () => {
  it('recusa executável renomeado para PDF', () => {
    const check = validateUpload({ ...base, filename: 'relatorio.pdf', declaredMime: 'application/pdf', bytes: ELF });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain('não corresponde');
  });

  it('recusa executável declarado como PNG', () => {
    expect(validateUpload({ ...base, filename: 'foto.png', declaredMime: 'image/png', bytes: ELF }).ok).toBe(false);
  });

  it('recusa PDF verdadeiro declarado como PNG', () => {
    expect(validateUpload({ ...base, filename: 'a.png', declaredMime: 'image/png', bytes: PDF }).ok).toBe(false);
  });

  it('recusa extensão que não combina com o tipo declarado', () => {
    const check = validateUpload({ ...base, filename: 'malicioso.exe', declaredMime: 'application/pdf', bytes: PDF });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain('extensão');
  });

  it('recusa binário disfarçado de texto', () => {
    const binario = Buffer.from([0x41, 0x00, 0x42, 0x00]);
    expect(validateUpload({ ...base, filename: 'a.txt', declaredMime: 'text/plain', bytes: binario }).ok).toBe(false);
  });

  it('recusa WebP com cabeçalho RIFF mas conteúdo de outra coisa', () => {
    // RIFF também é WAV e AVI: sem checar o marcador em 8..12, passaria.
    const riffFalso = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]);
    expect(validateUpload({ ...base, filename: 'a.webp', declaredMime: 'image/webp', bytes: riffFalso }).ok).toBe(false);
  });
});

describe('tamanho', () => {
  it('recusa acima do limite do plano', () => {
    const grande = Buffer.concat([PDF, Buffer.alloc(6 * MB)]);
    const check = validateUpload({ filename: 'a.pdf', declaredMime: 'application/pdf', bytes: grande, maxBytes: 5 * MB });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain('5 MB');
  });

  it('recusa arquivo vazio', () => {
    expect(
      validateUpload({ ...base, filename: 'a.pdf', declaredMime: 'application/pdf', bytes: Buffer.alloc(0) }).ok,
    ).toBe(false);
  });
});

describe('restrição do campo do formulário', () => {
  it('respeita a lista de MIME aceita pelo campo', () => {
    const somentePdf = { ...base, acceptedMimeTypes: ['application/pdf'] };

    expect(validateUpload({ ...somentePdf, filename: 'a.pdf', declaredMime: 'application/pdf', bytes: PDF }).ok).toBe(true);
    expect(validateUpload({ ...somentePdf, filename: 'a.png', declaredMime: 'image/png', bytes: PNG }).ok).toBe(false);
  });
});

describe('nome do arquivo', () => {
  it('neutraliza caminho e caracteres de controle', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('nota\u0000.pdf')).toBe('nota.pdf');
    expect(sanitizeFilename('C:\\Windows\\system32')).toBe('C:_Windows_system32');
  });

  it('nunca devolve nome vazio', () => {
    expect(sanitizeFilename('   ')).toBe('arquivo');
    expect(sanitizeFilename('')).toBe('arquivo');
  });

  it('extrai a extensão em minúsculas', () => {
    expect(extensionOf('Relatorio.PDF')).toBe('pdf');
    expect(extensionOf('semextensao')).toBe('');
  });
});

describe('caminho no bucket', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const OUTRA = '22222222-2222-4222-8222-222222222222';

  it('sempre começa pelo organization_id', () => {
    const key = buildObjectKey(ORG, 'respostas');

    // O isolamento entre empresas não para no banco: vale para o bucket também.
    expect(key.startsWith(`${ORG}/`)).toBe(true);
    expect(keyBelongsTo(key, ORG)).toBe(true);
    expect(keyBelongsTo(key, OUTRA)).toBe(false);
  });

  it('o nome no storage é aleatório, nunca o que o usuário enviou', () => {
    const a = buildObjectKey(ORG, 'respostas');
    const b = buildObjectKey(ORG, 'respostas');

    expect(a).not.toBe(b);
    expect(a).toMatch(/\/[0-9a-f]{32}$/);
  });

  it('recusa organizationId que não é UUID', () => {
    // Uma barra a mais aqui furaria o prefixo de isolamento.
    expect(() => buildObjectKey('../outra-empresa', 'respostas')).toThrow();
    expect(() => buildObjectKey('', 'respostas')).toThrow();
  });

  it('prefixo parecido não conta como pertencer', () => {
    const key = buildObjectKey(ORG, 'respostas');
    expect(keyBelongsTo(key, ORG.slice(0, 8))).toBe(false);
  });
});
