import { describe, expect, it } from 'vitest';
import { classifyDomain, dnsInstructions, validateCustomDomain, verificationRecordName } from '@forms/shared';

/**
 * Validação de domínio de cliente.
 *
 * Esta é a primeira das três barreiras da seção 8. O que ela recusa nem chega a
 * virar linha em `custom_domains` — e, portanto, nunca chega ao endpoint que
 * autoriza emissão de certificado.
 */

const NOSSOS = { ownDomains: ['app.formularios.local', 'custom.formularios.local'] };

describe('domínios aceitos', () => {
  it('aceita subdomínio de empresa', () => {
    const resultado = validateCustomDomain('formularios.empresa.com.br', NOSSOS);

    expect(resultado.ok).toBe(true);
    expect(resultado.domain).toBe('formularios.empresa.com.br');
    expect(resultado.type).toBe('subdomain');
  });

  it('normaliza antes de validar', () => {
    const resultado = validateCustomDomain('  HTTPS://Formularios.Empresa.COM.BR:443/algum-caminho  ', NOSSOS);

    expect(resultado.ok).toBe(true);
    expect(resultado.domain).toBe('formularios.empresa.com.br');
  });

  it('aceita apex', () => {
    expect(validateCustomDomain('empresa.com.br', NOSSOS)).toMatchObject({ ok: true, type: 'apex' });
    expect(validateCustomDomain('empresa.com', NOSSOS)).toMatchObject({ ok: true, type: 'apex' });
  });
});

describe('domínios recusados', () => {
  it('recusa endereço IP', () => {
    // Certificado para IP não é o que o cliente quer, e apontar um IP nosso
    // não prova posse de nada.
    expect(validateCustomDomain('192.168.0.1', NOSSOS)).toMatchObject({ ok: false, reason: 'ip' });
    expect(validateCustomDomain('2001:db8::1', NOSSOS).ok).toBe(false);
  });

  it('recusa localhost e sufixos reservados', () => {
    for (const entrada of ['localhost', 'app.localhost', 'servidor.local', 'coisa.internal', 'x.example']) {
      expect(validateCustomDomain(entrada, NOSSOS), entrada).toMatchObject({ ok: false, reason: 'reservado' });
    }
  });

  it('recusa qualquer subdomínio nosso', () => {
    // Quem cadastrasse `app.formularios.local` passaria a servir conteúdo no
    // domínio onde vive a sessão dos clientes.
    for (const entrada of [
      'app.formularios.local',
      'custom.formularios.local',
      'formularios.local',
      'qualquer.formularios.local',
    ]) {
      expect(validateCustomDomain(entrada, NOSSOS), entrada).toMatchObject({ ok: false, reason: 'proprio' });
    }
  });

  it('bloquear o domínio-pai da plataforma não bloqueia o país inteiro', () => {
    // Se a plataforma vive em `app.produto.com.br`, o ancestral ingênuo seria
    // `com.br` — e recusar isso derrubaria TODOS os domínios dos clientes.
    const emProducao = { ownDomains: ['app.produto.com.br', 'custom.produto.com.br'] };

    expect(validateCustomDomain('produto.com.br', emProducao)).toMatchObject({ ok: false, reason: 'proprio' });
    expect(validateCustomDomain('qualquer.produto.com.br', emProducao)).toMatchObject({ ok: false, reason: 'proprio' });

    // E os domínios legítimos dos clientes continuam passando.
    expect(validateCustomDomain('formularios.empresa.com.br', emProducao).ok).toBe(true);
    expect(validateCustomDomain('empresa.com.br', emProducao).ok).toBe(true);
    expect(validateCustomDomain('outra.org.br', emProducao).ok).toBe(true);
  });

  it('recusa hospedagem compartilhada', () => {
    // Alguém que crie um subdomínio grátis nesses serviços e o aponte para cá
    // ganharia um certificado com aquele nome.
    for (const entrada of ['meuapp.vercel.app', 'coisa.herokuapp.com', 'x.github.io', 'algo.pages.dev']) {
      expect(validateCustomDomain(entrada, NOSSOS), entrada).toMatchObject({ ok: false, reason: 'lista_negra' });
    }
  });

  it('recusa rótulo com caractere que o DNS não aceita', () => {
    expect(validateCustomDomain('formulários.empresa.com.br', NOSSOS).ok).toBe(false);
    expect(validateCustomDomain('form_ularios.empresa.com.br', NOSSOS).ok).toBe(false);
    expect(validateCustomDomain('-inicio.empresa.com.br', NOSSOS).ok).toBe(false);
  });

  it('recusa vazio e domínio de um rótulo só', () => {
    expect(validateCustomDomain('', NOSSOS)).toMatchObject({ ok: false, reason: 'vazio' });
    expect(validateCustomDomain('empresa', NOSSOS)).toMatchObject({ ok: false, reason: 'formato_invalido' });
  });

  it('recusa domínio longo demais', () => {
    const gigante = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(20)}.com.br`;
    expect(validateCustomDomain(gigante, NOSSOS)).toMatchObject({ ok: false, reason: 'muito_longo' });
  });
});

describe('classificação', () => {
  it('trata domínio de segundo nível brasileiro como apex', () => {
    // `empresa.com.br` é o registrável, não um subdomínio de `com.br` — e a
    // diferença muda a instrução de DNS que o cliente recebe.
    expect(classifyDomain('empresa.com.br')).toBe('apex');
    expect(classifyDomain('empresa.org.br')).toBe('apex');
    expect(classifyDomain('formularios.empresa.com.br')).toBe('subdomain');
  });

  it('trata .com simples corretamente', () => {
    expect(classifyDomain('empresa.com')).toBe('apex');
    expect(classifyDomain('formularios.empresa.com')).toBe('subdomain');
  });
});

describe('instruções de DNS', () => {
  it('subdomínio recebe CNAME e TXT', () => {
    const instrucoes = dnsInstructions({
      domain: 'formularios.empresa.com.br',
      verificationToken: 'formularios-verificacao=abc',
      cnameTarget: 'custom.formularios.local',
    });

    expect(instrucoes.type).toBe('subdomain');

    const cname = instrucoes.registros.find((r) => r.tipo === 'CNAME');
    expect(cname).toMatchObject({ nome: 'formularios', valor: 'custom.formularios.local' });

    const txt = instrucoes.registros.find((r) => r.tipo === 'TXT');
    expect(txt).toMatchObject({ nome: '_verify.formularios', valor: 'formularios-verificacao=abc' });
  });

  it('apex recebe registro A e explica por que não é CNAME', () => {
    const instrucoes = dnsInstructions({
      domain: 'empresa.com.br',
      verificationToken: 'formularios-verificacao=abc',
      cnameTarget: 'custom.formularios.local',
      edgeIp: '203.0.113.10',
    });

    expect(instrucoes.type).toBe('apex');

    const a = instrucoes.registros.find((r) => r.tipo === 'A');
    expect(a).toMatchObject({ nome: '@', valor: '203.0.113.10' });
    // Instrução errada aqui é a causa número um de chamado em domínio próprio.
    expect(a?.observacao).toContain('não aceita CNAME');
    expect(a?.observacao).toContain('ALIAS');
  });

  it('o nome do registro de verificação acompanha o subdomínio', () => {
    expect(verificationRecordName('formularios.empresa.com.br')).toBe('_verify.formularios');
    expect(verificationRecordName('empresa.com.br')).toBe('_verify.empresa');
  });
});
