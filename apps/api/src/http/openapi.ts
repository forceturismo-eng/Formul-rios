import { API_SCOPES } from '../services/api-keys-service.js';
import { WEBHOOK_EVENTS } from '../services/webhooks-service.js';
import { ANALYSIS_TYPES } from '../ai/provider.js';
import { ERROR_CODES, HTTP_STATUS_BY_CODE, PLANS } from '@forms/shared';
import { env } from '../config/env.js';

/**
 * Documento OpenAPI 3.1.
 *
 * Montado em código, e não escrito à mão num YAML, por um motivo: os escopos de
 * chave, os eventos de webhook, os tipos de análise, os códigos de erro e os
 * planos vêm das MESMAS constantes que a aplicação usa. Um escopo novo aparece
 * aqui sozinho; um YAML paralelo envelheceria em silêncio, e documentação
 * errada é pior do que documentação ausente.
 *
 * O que não é gerado — descrições, exemplos, o texto que explica por que um
 * endpoint existe — está escrito à mão, porque é justamente isso que uma
 * geração automática não produz.
 */

type Schema = Record<string, unknown>;

const erroSchema: Schema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: [...ERROR_CODES] },
        message: { type: 'string' },
        details: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'Erros de validação, campo a campo.',
        },
        limit: { type: 'integer' },
        current: { type: 'integer' },
        upgradeUrl: { type: 'string' },
        addonUrl: { type: 'string' },
      },
    },
  },
};

/** Respostas de erro comuns, para não repetir em cada operação. */
function errosPadrao(...codigos: Array<keyof typeof HTTP_STATUS_BY_CODE>): Schema {
  const saida: Schema = {};

  for (const codigo of codigos) {
    saida[String(HTTP_STATUS_BY_CODE[codigo])] = {
      description: DESCRICAO_DE_ERRO[codigo],
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Erro' } } },
    };
  }

  return saida;
}

const DESCRICAO_DE_ERRO: Record<string, string> = {
  validation_error: 'Entrada inválida. `details` traz o erro por campo.',
  unauthorized: 'Sem sessão válida, ou credencial expirada.',
  forbidden: 'Papel ou escopo insuficiente para a ação. A existência do recurso já é conhecida.',
  not_found: 'Não existe **ou** pertence a outra empresa. Os dois casos respondem igual, de propósito.',
  conflict: 'Conflito de estado — duplicidade, ou versão desatualizada.',
  rate_limited: 'Limite de requisições atingido.',
  quota_exceeded: 'Limite do plano atingido. `upgradeUrl` e `addonUrl` dizem o caminho.',
  payment_required: 'Pagamento pendente.',
  email_not_verified: 'A ação exige e-mail confirmado.',
  service_unavailable: 'Um serviço de terceiro está indisponível. É temporário.',
  internal_error: 'Erro do nosso lado.',
};

const paginacao = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
];

const idNaRota = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export function buildOpenApiDocument(): Schema {
  const produto = env.branding.productName;

  return {
    openapi: '3.1.0',

    info: {
      title: `API do ${produto}`,
      version: '1.0.0',
      description: [
        `Plataforma de formulários online multi-empresa.`,
        '',
        '## Três formas de autenticar',
        '',
        '| Uso | Como | Onde |',
        '| --- | --- | --- |',
        '| Painel | `Authorization: Bearer <access token>` | `/v1/*` |',
        '| Integração | `Authorization: Bearer fx_live_…` | `/api/v1/*` |',
        '| Operação da plataforma | token de admin, com MFA | `/admin/*` |',
        '',
        'As três são independentes. Um token de uma não abre as rotas da outra.',
        '',
        '## Isolamento entre empresas',
        '',
        'Recurso de outra empresa responde **404**, nunca 403. Um 403 confirmaria',
        'que o recurso existe, e isso é vazamento mesmo sem o conteúdo.',
        '',
        'A empresa do request vem sempre do token verificado. Nenhum cabeçalho,',
        'parâmetro de query ou campo de corpo muda de qual empresa você lê.',
        '',
        '## Limites de plano',
        '',
        'Quando um limite é atingido, a resposta é **402** com `code: quota_exceeded`,',
        '`limit`, `current` e o caminho para resolver. Respostas de formulário acima',
        'da cota **nunca são descartadas**: elas entram numa cortesia de 48 horas.',
      ].join('\n'),
      contact: { name: 'Suporte', url: env.branding.appUrl },
    },

    servers: [
      { url: env.branding.appUrl, description: 'Este ambiente' },
      { url: `https://${env.branding.appDomain}`, description: 'Produção' },
    ],

    tags: [
      { name: 'Autenticação', description: 'Registro, login, refresh rotativo e verificação de e-mail.' },
      { name: 'Formulários', description: 'CRUD, versionamento e publicação.' },
      { name: 'Recebimentos', description: 'Respostas, comentários, atribuições e exportações.' },
      { name: 'Público', description: 'Renderizador e submissão. Sem autenticação, servido em qualquer domínio.' },
      { name: 'Organização', description: 'Membros, convites, uso e trilha de auditoria.' },
      { name: 'Cobrança', description: 'Assinatura, faturas, Pix e boleto.' },
      { name: 'Integrações', description: 'Domínios próprios, webhooks e chaves de API.' },
      { name: 'Marca', description: 'White-label: logo, cores, meta tags e CSS.' },
      { name: 'IA', description: 'Análises das respostas, com consentimento e redação de PII.' },
      { name: 'API pública', description: 'Autenticada por chave, com escopos.' },
      { name: 'Admin', description: 'Operação da plataforma. Autenticação distinta e MFA obrigatório.' },
    ],

    components: {
      securitySchemes: {
        sessao: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token de 15 minutos, obtido em `POST /v1/auth/login`.',
        },
        chaveDeApi: {
          type: 'http',
          scheme: 'bearer',
          description: [
            'Chave criada em `POST /v1/api-keys`, no formato `fx_live_…`.',
            'Ela é mostrada **uma vez**: o banco guarda apenas o hash.',
            '',
            `Escopos: ${API_SCOPES.map((escopo) => `\`${escopo}\``).join(', ')}.`,
          ].join('\n'),
        },
        tokenDeAdmin: {
          type: 'http',
          scheme: 'bearer',
          description: 'Token de 30 minutos da área de administração. Exige MFA configurado.',
        },
      },

      schemas: {
        Erro: erroSchema,

        Plano: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: PLANS.map((plano) => plano.code) },
            name: { type: 'string' },
            priceMonthlyCents: { type: 'integer' },
            priceYearlyCents: { type: 'integer' },
          },
        },

        Formulario: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string', nullable: true },
            slugPublic: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'published', 'archived'] },
            version: { type: 'integer' },
            revision: {
              type: 'integer',
              description:
                'Contador de lock otimista. Envie o valor lido; se ele mudou, a resposta é 409.',
            },
            responseCount: { type: 'integer' },
          },
        },

        Resposta: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            formId: { type: 'string', format: 'uuid' },
            values: {
              type: 'object',
              additionalProperties: true,
              description: 'Conteúdo decifrado. Em repouso ele é cifrado com AES-256-GCM por resposta.',
            },
            status: { type: 'string', enum: ['new', 'reviewed', 'archived'] },
            isFlagged: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },

        Webhook: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            url: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
            isActive: { type: 'boolean' },
            lastStatus: { type: 'integer', nullable: true },
            failureCount: { type: 'integer' },
          },
        },

        Analise: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: [...ANALYSIS_TYPES] },
            result: { type: 'object', additionalProperties: true },
            generatedByAi: { type: 'boolean', const: true },
          },
        },
      },
    },

    security: [{ sessao: [] }],

    paths: caminhos(),
  };
}

function caminhos(): Schema {
  return {
    '/health': {
      get: {
        tags: ['Autenticação'],
        summary: 'Verificação de saúde',
        security: [],
        responses: { '200': { description: 'A API está no ar.' } },
      },
    },

    // -------------------------------------------------------------------------
    // Autenticação
    // -------------------------------------------------------------------------

    '/v1/auth/register': {
      post: {
        tags: ['Autenticação'],
        summary: 'Cria a conta e a empresa',
        description:
          'Registro sempre cria uma empresa junto e coloca quem se registrou como `owner`. ' +
          'Não existe usuário sem empresa.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password', 'organizationName'],
                properties: {
                  name: { type: 'string', maxLength: 160 },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 12 },
                  organizationName: { type: 'string', maxLength: 120 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Conta criada. O access token vem no corpo; o refresh, em cookie.' },
          ...errosPadrao('validation_error', 'conflict', 'rate_limited'),
        },
      },
    },

    '/v1/auth/login': {
      post: {
        tags: ['Autenticação'],
        summary: 'Entra',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  organizationId: {
                    type: 'string',
                    format: 'uuid',
                    description: 'Quando a pessoa está em mais de uma empresa.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Access token e cookie de refresh.' },
          ...errosPadrao('unauthorized', 'rate_limited'),
        },
      },
    },

    '/v1/auth/refresh': {
      post: {
        tags: ['Autenticação'],
        summary: 'Renova a sessão',
        description:
          'Rotativo: o token antigo é queimado. Reapresentar um token já rotacionado ' +
          'derruba a família inteira de sessões — é sinal de roubo.',
        security: [],
        responses: {
          '200': { description: 'Novo access token e novo cookie.' },
          ...errosPadrao('unauthorized'),
        },
      },
    },

    // -------------------------------------------------------------------------
    // Formulários
    // -------------------------------------------------------------------------

    '/v1/forms': {
      get: {
        tags: ['Formulários'],
        summary: 'Lista os formulários da empresa',
        parameters: paginacao,
        responses: {
          '200': {
            description: 'Formulários que este usuário pode ver.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    forms: { type: 'array', items: { $ref: '#/components/schemas/Formulario' } },
                  },
                },
              },
            },
          },
          ...errosPadrao('unauthorized'),
        },
      },
      post: {
        tags: ['Formulários'],
        summary: 'Cria um formulário',
        responses: {
          '201': { description: 'Criado, em rascunho.' },
          ...errosPadrao('validation_error', 'quota_exceeded', 'email_not_verified'),
        },
      },
    },

    '/v1/forms/{id}': {
      parameters: [idNaRota],
      get: {
        tags: ['Formulários'],
        summary: 'Lê um formulário',
        responses: {
          '200': {
            description: 'O formulário.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Formulario' } } },
          },
          ...errosPadrao('not_found'),
        },
      },
      patch: {
        tags: ['Formulários'],
        summary: 'Altera um formulário',
        description:
          'Use `revision` para lock otimista. Se outra pessoa salvou entre a sua leitura e ' +
          'a sua escrita, a resposta é 409 e nada é perdido.',
        responses: {
          '200': { description: 'Alterado.' },
          ...errosPadrao('validation_error', 'conflict', 'not_found'),
        },
      },
      delete: {
        tags: ['Formulários'],
        summary: 'Apaga um formulário',
        description: 'Soft delete. As respostas continuam no banco e contam para a retenção do plano.',
        responses: { '204': { description: 'Apagado.' }, ...errosPadrao('not_found') },
      },
    },

    '/v1/forms/{id}/publish': {
      parameters: [idNaRota],
      post: {
        tags: ['Formulários'],
        summary: 'Publica a versão atual',
        description:
          'Cria uma versão imutável. Respostas guardam o número da versão em que foram ' +
          'enviadas, para que editar o formulário depois não reescreva o passado.',
        responses: { '200': { description: 'Publicado.' }, ...errosPadrao('not_found', 'quota_exceeded') },
      },
    },

    // -------------------------------------------------------------------------
    // Recebimentos
    // -------------------------------------------------------------------------

    '/v1/forms/{id}/responses': {
      parameters: [idNaRota],
      get: {
        tags: ['Recebimentos'],
        summary: 'Lista as respostas de um formulário',
        parameters: [
          ...paginacao,
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['new', 'reviewed', 'archived'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Respostas decifradas.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    responses: { type: 'array', items: { $ref: '#/components/schemas/Resposta' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...errosPadrao('not_found'),
        },
      },
    },

    '/v1/forms/{id}/exports': {
      parameters: [idNaRota],
      post: {
        tags: ['Recebimentos'],
        summary: 'Pede uma exportação',
        description:
          'Responde 202: o arquivo é gerado em fila. Exportar 25 mil respostas, cada uma ' +
          'decifrada individualmente, não cabe no tempo de um request.',
        responses: { '202': { description: 'Na fila.' }, ...errosPadrao('not_found', 'quota_exceeded') },
      },
    },

    '/v1/exports/{id}/download-url': {
      parameters: [idNaRota],
      get: {
        tags: ['Recebimentos'],
        summary: 'URL assinada do arquivo',
        description: 'Válida por 5 minutos. O bucket é privado; não existe URL pública.',
        responses: { '200': { description: 'A URL.' }, ...errosPadrao('not_found') },
      },
    },

    // -------------------------------------------------------------------------
    // Público
    // -------------------------------------------------------------------------

    '/f/{slug}': {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Público'],
        summary: 'Formulário publicado',
        description:
          'Sem autenticação, e servido também nos domínios dos clientes. Com ' +
          '`Accept: text/html`, devolve a página com as meta tags no `<head>` — é o que o ' +
          'robô de prévia de link do WhatsApp lê, e ele não roda script.',
        security: [],
        responses: {
          '200': { description: 'O formulário, ou o HTML da página.' },
          ...errosPadrao('not_found'),
        },
      },
    },

    '/f/{slug}/submit': {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        tags: ['Público'],
        summary: 'Envia uma resposta',
        description:
          'A resposta é validada com o mesmo schema do painel, cifrada antes de tocar o banco ' +
          'e nunca descartada por limite de plano — acima da cota ela entra na cortesia de 48h.',
        security: [],
        responses: {
          '201': { description: 'Recebida.' },
          ...errosPadrao('validation_error', 'forbidden', 'rate_limited'),
        },
      },
    },

    // -------------------------------------------------------------------------
    // Organização
    // -------------------------------------------------------------------------

    '/v1/organizations/current': {
      get: {
        tags: ['Organização'],
        summary: 'A empresa da sessão',
        description:
          'Traz `impersonation` quando um admin da plataforma está dentro da conta. ' +
          'É daqui que sai o banner permanente.',
        responses: { '200': { description: 'A empresa, o plano e o papel.' }, ...errosPadrao('unauthorized') },
      },
    },

    '/v1/usage': {
      get: {
        tags: ['Organização'],
        summary: 'Uso do ciclo e avisos',
        responses: { '200': { description: 'Contadores, limites e avisos de 80%.' } },
      },
    },

    '/v1/audit-logs': {
      get: {
        tags: ['Organização'],
        summary: 'Trilha de auditoria da empresa',
        description:
          'Inclui as ações da plataforma sobre esta conta — suspensão, mudança de plano e ' +
          'impersonação aparecem aqui, sem precisar pedir.',
        responses: { '200': { description: 'As entradas.' }, ...errosPadrao('forbidden') },
      },
    },

    // -------------------------------------------------------------------------
    // Integrações
    // -------------------------------------------------------------------------

    '/v1/custom-domains': {
      get: {
        tags: ['Integrações'],
        summary: 'Domínios próprios',
        responses: { '200': { description: 'Domínios e o alvo do CNAME.' } },
      },
      post: {
        tags: ['Integrações'],
        summary: 'Cadastra um domínio',
        description: 'Devolve os registros de DNS a configurar. O certificado é emitido depois da verificação.',
        responses: {
          '201': { description: 'Cadastrado, aguardando DNS.' },
          ...errosPadrao('validation_error', 'quota_exceeded'),
        },
      },
    },

    '/v1/webhooks': {
      get: {
        tags: ['Integrações'],
        summary: 'Webhooks de saída',
        responses: {
          '200': {
            description: 'Os webhooks. O segredo nunca volta aqui.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    webhooks: { type: 'array', items: { $ref: '#/components/schemas/Webhook' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Integrações'],
        summary: 'Cadastra um webhook',
        description: [
          'Só `https`. O destino é resolvido antes de cada entrega, e um IP em faixa privada',
          'cancela o envio.',
          '',
          'Cada entrega vai assinada:',
          '',
          '```',
          'X-Formularios-Signature: t=<timestamp>,v1=<hmac-sha256 de "<t>.<payload>">',
          '```',
          '',
          'Confira a assinatura **e** a idade do timestamp — a tolerância de referência é 5 minutos.',
        ].join('\n'),
        responses: {
          '201': { description: 'Criado. O segredo aparece uma vez.' },
          ...errosPadrao('validation_error', 'quota_exceeded'),
        },
      },
    },

    '/v1/api-keys': {
      get: { tags: ['Integrações'], summary: 'Chaves de API', responses: { '200': { description: 'As chaves.' } } },
      post: {
        tags: ['Integrações'],
        summary: 'Cria uma chave',
        description: `A chave aparece uma vez. Escopos: ${API_SCOPES.join(', ')}.`,
        responses: {
          '201': { description: 'Criada.' },
          ...errosPadrao('validation_error', 'quota_exceeded'),
        },
      },
    },

    // -------------------------------------------------------------------------
    // Marca
    // -------------------------------------------------------------------------

    '/v1/branding': {
      get: {
        tags: ['Marca'],
        summary: 'Branding da empresa',
        responses: { '200': { description: 'O que está gravado, a prévia do CSS e o que o plano libera.' } },
      },
      patch: {
        tags: ['Marca'],
        summary: 'Altera o branding',
        description: '`null` em um campo o limpa. Imagens precisam ser `https`.',
        responses: { '200': { description: 'Alterado.' }, ...errosPadrao('validation_error', 'quota_exceeded') },
      },
    },

    '/v1/branding/preview-css': {
      post: {
        tags: ['Marca'],
        summary: 'Prévia do CSS sanitizado',
        description:
          'Devolve o que sobra da folha e a lista do que foi removido, com o motivo. ' +
          'A sanitização usa lista de permissão: o que não está nela não passa.',
        responses: { '200': { description: 'CSS resultante e motivos.' } },
      },
    },

    // -------------------------------------------------------------------------
    // IA
    // -------------------------------------------------------------------------

    '/v1/ai/consent': {
      put: {
        tags: ['IA'],
        summary: 'Liga e desliga as análises',
        description:
          'Padrão desligado. Com o consentimento desligado, nenhuma resposta é enviada a ' +
          'terceiro. Ligar e desligar ficam na trilha de auditoria.',
        responses: { '200': { description: 'Estado atualizado.' }, ...errosPadrao('forbidden') },
      },
    },

    '/v1/forms/{id}/ai-analyses': {
      parameters: [idNaRota],
      get: {
        tags: ['IA'],
        summary: 'Análises já feitas',
        responses: {
          '200': {
            description: 'As análises.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    analyses: { type: 'array', items: { $ref: '#/components/schemas/Analise' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['IA'],
        summary: 'Pede uma análise',
        description: [
          `Tipos: ${ANALYSIS_TYPES.join(', ')}.`,
          '',
          'Responde **200** quando já existe resultado para exatamente estas respostas — nesse',
          'caso nada é reprocessado e a cota não é consumida — e **202** quando entrou na fila.',
          '',
          'Os dados pessoais são removidos antes do envio, sempre. Nomes, e-mails, CPFs, CNPJs,',
          'telefones, CEPs e cartões viram pseudônimos estáveis (`[EMAIL_1]`), que preservam a',
          'análise sem expor ninguém. A resposta 202 diz quantos foram removidos.',
        ].join('\n'),
        responses: {
          '200': { description: 'Já havia resultado.' },
          '202': { description: 'Na fila.' },
          ...errosPadrao('validation_error', 'forbidden', 'quota_exceeded', 'service_unavailable'),
        },
      },
    },

    // -------------------------------------------------------------------------
    // API pública
    // -------------------------------------------------------------------------

    '/api/v1/me': {
      get: {
        tags: ['API pública'],
        summary: 'Quem é esta chave',
        security: [{ chaveDeApi: [] }],
        responses: { '200': { description: 'Empresa e escopos.' }, ...errosPadrao('unauthorized') },
      },
    },

    '/api/v1/forms': {
      get: {
        tags: ['API pública'],
        summary: 'Formulários da empresa',
        description: 'Exige o escopo `forms:read`.',
        security: [{ chaveDeApi: [] }],
        responses: {
          '200': { description: 'Os formulários.' },
          ...errosPadrao('unauthorized', 'forbidden'),
        },
      },
    },

    '/api/v1/forms/{id}/responses': {
      parameters: [idNaRota],
      get: {
        tags: ['API pública'],
        summary: 'Respostas de um formulário',
        description:
          'Exige o escopo `responses:read`. Escopo insuficiente responde 403 nomeando o que ' +
          'falta; formulário de outra empresa responde 404.',
        security: [{ chaveDeApi: [] }],
        parameters: paginacao,
        responses: {
          '200': { description: 'As respostas, decifradas.' },
          ...errosPadrao('unauthorized', 'forbidden', 'not_found'),
        },
      },
    },

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    '/admin/auth/login': {
      post: {
        tags: ['Admin'],
        summary: 'Entra na área de administração',
        description:
          'Senha **e** código TOTP. Sem MFA configurado, devolve o QR Code e nada mais: ' +
          'enquanto o segundo fator não estiver ativo, a conta não acessa nenhuma rota.',
        security: [],
        responses: {
          '200': { description: 'Token de 30 minutos, ou os dados de configuração do MFA.' },
          ...errosPadrao('unauthorized', 'rate_limited'),
        },
      },
    },

    '/admin/metrics': {
      get: {
        tags: ['Admin'],
        summary: 'Métricas da plataforma',
        description:
          'MRR, churn, inadimplência e uso. Só números: as funções do banco que servem esta ' +
          'rota não têm coluna de conteúdo no retorno.',
        security: [{ tokenDeAdmin: [] }],
        responses: { '200': { description: 'Os agregados.' }, ...errosPadrao('unauthorized') },
      },
    },

    '/admin/organizations/{id}/impersonate': {
      parameters: [idNaRota],
      post: {
        tags: ['Admin'],
        summary: 'Entra na conta de um cliente',
        description: [
          'Devolve um access token de cliente, válido por 15 minutos e **somente leitura**.',
          '',
          'O motivo é obrigatório e fica registrado dos dois lados: na nossa trilha e no',
          '`audit_logs` da empresa, onde o cliente vê sem precisar pedir. O painel dele',
          'mostra um banner permanente enquanto o acesso durar.',
        ].join('\n'),
        security: [{ tokenDeAdmin: [] }],
        responses: {
          '200': { description: 'Token de impersonação.' },
          ...errosPadrao('validation_error', 'unauthorized', 'not_found', 'conflict'),
        },
      },
    },
  };
}
