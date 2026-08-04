import { describe, expect, it } from 'vitest';
import {
  detectDocumentType,
  formatCEP,
  formatDocument,
  isValidCEP,
  isValidCNPJ,
  isValidCPF,
  isValidDocument,
  normalizeHost,
  slugify,
  isReservedSlug,
} from '@forms/shared';

/**
 * Validações brasileiras. O ponto destes testes são os casos em que o formato
 * está certo e o documento é falso — é exatamente aí que uma validação por
 * regex passa e uma validação por algoritmo pega.
 */

describe('CPF', () => {
  it('aceita CPF válido, com e sem máscara', () => {
    expect(isValidCPF('529.982.247-25')).toBe(true);
    expect(isValidCPF('52998224725')).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    expect(isValidCPF('529.982.247-26')).toBe(false);
  });

  it('recusa todos os dígitos iguais, que passam na conta ingênua', () => {
    for (const d of '0123456789') {
      expect(isValidCPF(d.repeat(11)), d.repeat(11)).toBe(false);
    }
  });

  it('recusa comprimento errado', () => {
    expect(isValidCPF('5299822472')).toBe(false);
    expect(isValidCPF('529982247251')).toBe(false);
    expect(isValidCPF('')).toBe(false);
  });
});

describe('CNPJ', () => {
  it('aceita CNPJ válido, com e sem máscara', () => {
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true);
    expect(isValidCNPJ('11222333000181')).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    expect(isValidCNPJ('11.222.333/0001-82')).toBe(false);
  });

  it('recusa todos os dígitos iguais', () => {
    expect(isValidCNPJ('11111111111111')).toBe(false);
    expect(isValidCNPJ('00000000000000')).toBe(false);
  });
});

describe('documento genérico', () => {
  it('detecta o tipo pelo tamanho', () => {
    expect(detectDocumentType('52998224725')).toBe('cpf');
    expect(detectDocumentType('11222333000181')).toBe('cnpj');
    expect(detectDocumentType('123')).toBeNull();
  });

  it('valida qualquer um dos dois', () => {
    expect(isValidDocument('529.982.247-25')).toBe(true);
    expect(isValidDocument('11.222.333/0001-81')).toBe(true);
    expect(isValidDocument('123')).toBe(false);
  });

  it('formata conforme o tipo', () => {
    expect(formatDocument('52998224725')).toBe('529.982.247-25');
    expect(formatDocument('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('CEP', () => {
  it('valida oito dígitos', () => {
    expect(isValidCEP('01310-100')).toBe(true);
    expect(isValidCEP('01310100')).toBe(true);
    expect(isValidCEP('0131010')).toBe(false);
  });

  it('formata', () => {
    expect(formatCEP('01310100')).toBe('01310-100');
  });
});

describe('slug', () => {
  it('remove acento e normaliza', () => {
    expect(slugify('Agência Alfa')).toBe('agencia-alfa');
    expect(slugify('Clínica Beta & Cia.')).toBe('clinica-beta-cia');
    expect(slugify('  espaços  demais  ')).toBe('espacos-demais');
  });

  it('protege as rotas do próprio produto', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('api')).toBe(true);
    expect(isReservedSlug('agencia-alfa')).toBe(false);
  });
});

describe('normalização de host', () => {
  it('derruba protocolo, porta, caminho e caixa', () => {
    expect(normalizeHost('HTTPS://App.Exemplo.com.br:443/painel')).toBe('app.exemplo.com.br');
    expect(normalizeHost('localhost:3333')).toBe('localhost');
    // Ponto final é sintaxe de FQDN e faria "exemplo.com." escapar da lista.
    expect(normalizeHost('exemplo.com.')).toBe('exemplo.com');
    expect(normalizeHost(undefined)).toBe('');
  });
});
