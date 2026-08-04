import { describe, expect, it } from 'vitest';
import { matchPath, sanitizePath } from '../../apps/web/src/lib/router.js';

/**
 * Roteador próprio do app web.
 *
 * `sanitizePath` é código de segurança, não conveniência: ele é a razão pela
 * qual trocar o React Router por sessenta linhas caseiras não reintroduziu a
 * classe de bug que estava nas CVEs — open redirect via `<Link>` e
 * `useNavigate`. Por isso ele tem teste próprio.
 */

describe('sanitizePath', () => {
  it('aceita caminho interno', () => {
    expect(sanitizePath('/formularios')).toBe('/formularios');
    expect(sanitizePath('/formularios/abc/respostas')).toBe('/formularios/abc/respostas');
    expect(sanitizePath('/planos?ciclo=anual')).toBe('/planos?ciclo=anual');
  });

  it('recusa URL absoluta para outro site', () => {
    expect(sanitizePath('https://evil.example.com')).toBe('/');
    expect(sanitizePath('http://evil.example.com/phishing')).toBe('/');
  });

  it('recusa URL relativa a protocolo', () => {
    // `//evil.com` é interpretado pelo navegador como https://evil.com.
    expect(sanitizePath('//evil.example.com')).toBe('/');
    expect(sanitizePath('///evil.example.com')).toBe('/');
  });

  it('recusa contrabarra, que alguns navegadores normalizam para barra', () => {
    // Foi exatamente o bypass da CVE-2025-68470.
    expect(sanitizePath('\\\\evil.example.com')).toBe('/');
    expect(sanitizePath('/\\evil.example.com')).toBe('/');
    expect(sanitizePath('\\/evil.example.com')).toBe('/');
  });

  it('recusa esquemas perigosos', () => {
    expect(sanitizePath('javascript:alert(1)')).toBe('/');
    expect(sanitizePath('data:text/html,<script>alert(1)</script>')).toBe('/');
    expect(sanitizePath('/javascript:alert(1)')).toBe('/');
  });

  it('recusa caminho que não começa com barra', () => {
    expect(sanitizePath('formularios')).toBe('/');
    expect(sanitizePath('')).toBe('/');
    expect(sanitizePath('   ')).toBe('/');
  });
});

describe('matchPath', () => {
  it('casa rota sem parâmetro', () => {
    expect(matchPath('/formularios', '/formularios')).toEqual({});
    expect(matchPath('/formularios', '/equipe')).toBeNull();
  });

  it('extrai parâmetros', () => {
    expect(matchPath('/formularios/:id', '/formularios/abc-123')).toEqual({ id: 'abc-123' });
    expect(matchPath('/formularios/:id/respostas', '/formularios/xyz/respostas')).toEqual({ id: 'xyz' });
  });

  it('não casa quando o número de segmentos difere', () => {
    expect(matchPath('/formularios/:id', '/formularios')).toBeNull();
    expect(matchPath('/formularios/:id', '/formularios/abc/respostas')).toBeNull();
  });

  it('decodifica o parâmetro', () => {
    expect(matchPath('/f/:slug', '/f/contato%20geral')).toEqual({ slug: 'contato geral' });
  });

  it('distingue rota estática de parâmetro na mesma posição', () => {
    // `/formularios/:id` não pode engolir `/formularios/novo` se um dia existir
    // uma rota estática com esse nome — a estática é comparada literalmente.
    expect(matchPath('/formularios/novo', '/formularios/abc')).toBeNull();
    expect(matchPath('/formularios/novo', '/formularios/novo')).toEqual({});
  });
});
