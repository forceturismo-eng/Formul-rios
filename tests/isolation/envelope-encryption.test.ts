import { describe, expect, it } from 'vitest';
import { decryptResponseData, encryptResponseData, redactPII } from '../../apps/api/src/crypto/envelope.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';

/**
 * TESTE BLOQUEANTE — a fronteira entre empresas também vale na criptografia.
 *
 * O RLS impede que a Empresa A leia a linha da Empresa B. Este teste cobre o
 * caso seguinte: alguém com acesso direto ao banco copia a linha de uma
 * organização para outra. A chave é derivada por organização, então o
 * conteúdo continua ilegível.
 */

const resposta = {
  nome: 'Maria Silva',
  email: 'maria@exemplo.com.br',
  cpf: '52998224725',
  mensagem: 'Preciso de um orçamento para 300 unidades.',
};

describe('ida e volta', () => {
  it('cifra e decifra preservando o conteúdo', () => {
    const payload = encryptResponseData(ORG_A.id, resposta);
    expect(decryptResponseData(ORG_A.id, payload)).toEqual(resposta);
  });

  it('o conteúdo em claro não aparece no blob', () => {
    const payload = encryptResponseData(ORG_A.id, resposta);
    const bytes = Buffer.from(payload.dataEncrypted).toString('utf8') + Buffer.from(payload.dataKeyEncrypted).toString('utf8');

    expect(bytes).not.toContain('Maria');
    expect(bytes).not.toContain('maria@exemplo.com.br');
    expect(bytes).not.toContain('52998224725');
  });

  it('duas respostas iguais geram blobs diferentes', () => {
    // Chave de dados e IV são novos a cada resposta. Sem isso, um observador
    // saberia quais respostas são idênticas sem decifrar nenhuma.
    const a = encryptResponseData(ORG_A.id, resposta);
    const b = encryptResponseData(ORG_A.id, resposta);

    expect(Buffer.from(a.dataEncrypted).equals(Buffer.from(b.dataEncrypted))).toBe(false);
    expect(Buffer.from(a.dataKeyEncrypted).equals(Buffer.from(b.dataKeyEncrypted))).toBe(false);
  });

  it('aguenta acentuação, emoji e objeto aninhado', () => {
    const complexo = {
      texto: 'Ação, coração e não — três acentos 🇧🇷',
      endereco: { cidade: 'São Paulo', uf: 'SP' },
      itens: [1, 2, 3],
      vazio: null,
    };
    expect(decryptResponseData(ORG_A.id, encryptResponseData(ORG_A.id, complexo))).toEqual(complexo);
  });
});

describe('isolamento criptográfico entre empresas', () => {
  it('a Empresa B não decifra uma resposta da Empresa A', () => {
    const payload = encryptResponseData(ORG_A.id, resposta);

    // Este é o cenário de "alguém com acesso ao banco moveu a linha de tenant".
    // A chave é derivada do organization_id, então ela simplesmente não abre.
    expect(() => decryptResponseData(ORG_B.id, payload)).toThrow();
  });

  it('trocar apenas a chave de dados entre empresas também falha', () => {
    const deA = encryptResponseData(ORG_A.id, resposta);
    const deB = encryptResponseData(ORG_B.id, { outro: 'conteúdo' });

    expect(() => decryptResponseData(ORG_A.id, { dataEncrypted: deA.dataEncrypted, dataKeyEncrypted: deB.dataKeyEncrypted })).toThrow();
    expect(() => decryptResponseData(ORG_B.id, { dataEncrypted: deB.dataEncrypted, dataKeyEncrypted: deA.dataKeyEncrypted })).toThrow();
  });
});

describe('integridade', () => {
  it('um byte alterado no conteúdo faz a decifragem falhar', () => {
    const payload = encryptResponseData(ORG_A.id, resposta);
    const adulterado = Buffer.from(payload.dataEncrypted);
    adulterado[adulterado.length - 1]! ^= 0xff;

    // AES-GCM autentica além de cifrar: adulteração vira erro, não lixo.
    expect(() => decryptResponseData(ORG_A.id, { ...payload, dataEncrypted: adulterado })).toThrow();
  });

  it('um byte alterado na chave cifrada faz a decifragem falhar', () => {
    const payload = encryptResponseData(ORG_A.id, resposta);
    const adulterado = Buffer.from(payload.dataKeyEncrypted);
    adulterado[0]! ^= 0xff;

    expect(() => decryptResponseData(ORG_A.id, { ...payload, dataKeyEncrypted: adulterado })).toThrow();
  });

  it('blob truncado falha com mensagem clara', () => {
    expect(() =>
      decryptResponseData(ORG_A.id, { dataEncrypted: Buffer.alloc(4), dataKeyEncrypted: Buffer.alloc(4) }),
    ).toThrow(/truncado/);
  });
});

describe('redação de PII antes de ir para a IA', () => {
  it('mascara CPF, CNPJ, telefone e CEP', () => {
    const texto = redactPII(
      'Meu CPF é 529.982.247-25, CNPJ 11.222.333/0001-81, telefone (11) 98765-4321 e CEP 01310-100.',
    ) as string;

    expect(texto).toContain('[CPF]');
    expect(texto).toContain('[CNPJ]');
    expect(texto).toContain('[TELEFONE]');
    expect(texto).toContain('[CEP]');
    expect(texto).not.toContain('529.982.247-25');
    expect(texto).not.toContain('98765-4321');
  });

  it('preserva o domínio do e-mail', () => {
    // O domínio costuma ser sinal útil para a análise (cliente corporativo),
    // e sozinho não identifica ninguém.
    const texto = redactPII('Escreva para maria.silva@empresa.com.br') as string;
    expect(texto).toContain('[EMAIL]@empresa.com.br');
    expect(texto).not.toContain('maria.silva');
  });

  it('mascara campo cujo nome já denuncia o conteúdo', () => {
    // O padrão textual não pegaria "João da Silva" — só o nome do campo pega.
    const objeto = redactPII({ nome: 'João da Silva', mensagem: 'tudo certo' }) as Record<string, string>;
    expect(objeto['nome']).toBe('[NOME]');
    expect(objeto['mensagem']).toBe('tudo certo');
  });

  it('percorre listas e objetos aninhados', () => {
    const resultado = redactPII({
      respostas: [{ contato: 'ligue (21) 3333-4444' }],
    }) as { respostas: Array<{ contato: string }> };

    expect(resultado.respostas[0]!.contato).toContain('[TELEFONE]');
  });
});
