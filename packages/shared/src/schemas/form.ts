import { z } from 'zod';

/**
 * O schema de um formulário.
 *
 * Este arquivo é o contrato entre o builder, o renderizador público e a
 * validação da submissão. Os três leem daqui — se divergissem, o builder
 * deixaria montar formulário que o renderizador não desenha, ou o
 * renderizador aceitaria resposta que a validação recusa.
 *
 * O `schema_json` guardado em `forms` e `form_versions` é exatamente o que
 * `formSchema` descreve. Ele é validado na gravação, e revalidado na leitura
 * antes de renderizar: um schema gravado por uma versão antiga do código não
 * pode derrubar a página pública de um cliente.
 */

// -----------------------------------------------------------------------------
// Tipos de campo
// -----------------------------------------------------------------------------

export const FIELD_TYPES = [
  'short_text',
  'long_text',
  'email',
  'phone_br',
  'cpf_cnpj',
  'cep',
  'number',
  'currency',
  'date',
  'time',
  'datetime',
  'single_select',
  'multi_select',
  'dropdown',
  'scale',
  'nps',
  'file_upload',
  'signature',
  'address',
  'matrix',
  'hidden',
  'payment',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Campos que só existem em planos superiores (seção 6.1). */
export const FEATURE_GATED_FIELDS: Partial<Record<FieldType, 'signatureField' | 'paymentFields'>> = {
  signature: 'signatureField',
  payment: 'paymentFields',
};

/** Identificador de campo: vira chave no JSON da resposta e referência na lógica. */
const fieldIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Use letras, números e _ , começando por letra.');

const optionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  /** Peso para cálculo e pontuação. */
  score: z.number().finite().optional(),
});

// -----------------------------------------------------------------------------
// Validações customizadas
// -----------------------------------------------------------------------------

export const validationSchema = z
  .object({
    minLength: z.number().int().min(0).max(100_000).optional(),
    maxLength: z.number().int().min(1).max(100_000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /**
     * Regex fornecida pelo cliente. Guardada como string e compilada com um
     * teto de tamanho — expressão longa demais é vetor de ReDoS, e ela roda no
     * servidor a cada submissão.
     */
    pattern: z.string().max(300).optional(),
    /** Mensagem própria, exibida no lugar da mensagem padrão. */
    message: z.string().max(300).optional(),
    /** Só para upload. */
    maxFiles: z.number().int().min(1).max(20).optional(),
    acceptedMimeTypes: z.array(z.string().max(150)).max(30).optional(),
  })
  .strict();

export type FieldValidation = z.infer<typeof validationSchema>;

// -----------------------------------------------------------------------------
// Lógica condicional
// -----------------------------------------------------------------------------

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionSchema = z
  .object({
    field: fieldIdSchema,
    operator: z.enum(CONDITION_OPERATORS),
    /** Ausente em `is_empty` / `is_not_empty`. */
    value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  })
  .strict();

export const LOGIC_ACTIONS = ['show', 'hide', 'require', 'skip_to_page'] as const;
export type LogicAction = (typeof LOGIC_ACTIONS)[number];

export const logicRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** `all` = E lógico, `any` = OU. Pelo menos um dos dois precisa existir. */
    when: z
      .object({
        all: z.array(conditionSchema).max(20).optional(),
        any: z.array(conditionSchema).max(20).optional(),
      })
      .strict()
      .refine((v) => (v.all?.length ?? 0) + (v.any?.length ?? 0) > 0, 'A regra precisa de ao menos uma condição.'),
    action: z.enum(LOGIC_ACTIONS),
    /** `fieldId` para show/hide/require, `pageId` para skip_to_page. */
    target: z.string().min(1).max(64),
  })
  .strict();

export type LogicRule = z.infer<typeof logicRuleSchema>;

// -----------------------------------------------------------------------------
// Campos
// -----------------------------------------------------------------------------

const baseFieldSchema = z.object({
  id: fieldIdSchema,
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(300),
  description: z.string().max(1000).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().default(false),
  /** Campo oculto: não é desenhado, mas viaja na resposta (UTM, origem). */
  defaultValue: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  validation: validationSchema.optional(),
  options: z.array(optionSchema).max(200).optional(),
  /**
   * Expressão de cálculo entre campos, tipo "quantidade * preco".
   * Avaliada por um interpretador próprio, nunca por `eval` — ver
   * `evaluateCalculation` em calculations.ts.
   */
  calculation: z.string().max(500).optional(),
  /** Escala e NPS. */
  scaleMin: z.number().int().optional(),
  scaleMax: z.number().int().optional(),
  scaleMinLabel: z.string().max(80).optional(),
  scaleMaxLabel: z.string().max(80).optional(),
  /** Matriz. */
  rows: z.array(optionSchema).max(50).optional(),
  columns: z.array(optionSchema).max(50).optional(),
});

export const fieldSchema = baseFieldSchema
  .strict()
  .superRefine((field, ctx) => {
    const precisaOpcoes: FieldType[] = ['single_select', 'multi_select', 'dropdown'];
    if (precisaOpcoes.includes(field.type) && (field.options?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Campos de seleção precisam de pelo menos uma opção.',
      });
    }

    if (field.type === 'matrix') {
      if ((field.rows?.length ?? 0) === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'A matriz precisa de linhas.' });
      }
      if ((field.columns?.length ?? 0) === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns'], message: 'A matriz precisa de colunas.' });
      }
    }

    if ((field.type === 'scale' || field.type === 'nps') && field.scaleMin !== undefined && field.scaleMax !== undefined) {
      if (field.scaleMin >= field.scaleMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scaleMax'],
          message: 'O fim da escala precisa ser maior que o começo.',
        });
      }
    }

    const v = field.validation;
    if (v?.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation', 'maxLength'],
        message: 'O tamanho máximo precisa ser maior que o mínimo.',
      });
    }
    if (v?.min !== undefined && v.max !== undefined && v.min > v.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation', 'max'],
        message: 'O valor máximo precisa ser maior que o mínimo.',
      });
    }
    if (v?.pattern) {
      try {
        new RegExp(v.pattern);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validation', 'pattern'],
          message: 'Essa expressão regular não é válida.',
        });
      }
    }
  });

export type FormField = z.infer<typeof fieldSchema>;

// -----------------------------------------------------------------------------
// Páginas e formulário
// -----------------------------------------------------------------------------

export const pageSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().max(300).optional(),
    description: z.string().max(2000).optional(),
    fields: z.array(fieldSchema).max(200),
  })
  .strict();

export type FormPage = z.infer<typeof pageSchema>;

export const formSchema = z
  .object({
    pages: z.array(pageSchema).min(1, 'O formulário precisa de ao menos uma página.').max(50),
    logic: z.array(logicRuleSchema).max(200).default([]),
    settings: z
      .object({
        showProgressBar: z.boolean().default(true),
        submitLabel: z.string().max(80).default('Enviar'),
        confirmationMessage: z.string().max(2000).default('Recebemos sua resposta. Obrigado.'),
        redirectUrl: z.string().url().max(2048).optional(),
        /** Honeypot: campo invisível que só robô preenche (seção 5.1). */
        honeypotEnabled: z.boolean().default(true),
        captchaEnabled: z.boolean().default(false),
        allowMultipleSubmissions: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((form, ctx) => {
    const idsDeCampo = new Set<string>();
    const idsDePagina = new Set<string>();

    form.pages.forEach((page, i) => {
      if (idsDePagina.has(page.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', i, 'id'],
          message: `Já existe uma página com o id "${page.id}".`,
        });
      }
      idsDePagina.add(page.id);

      page.fields.forEach((field, j) => {
        // IDs duplicados fariam uma resposta sobrescrever a outra no JSON.
        if (idsDeCampo.has(field.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', i, 'fields', j, 'id'],
            message: `Já existe um campo com o id "${field.id}".`,
          });
        }
        idsDeCampo.add(field.id);
      });
    });

    // Regra apontando para campo ou página que não existe é lógica morta que
    // some silenciosamente no renderizador. Melhor recusar na gravação.
    form.logic.forEach((rule, i) => {
      for (const [j, condition] of [...(rule.when.all ?? []), ...(rule.when.any ?? [])].entries()) {
        if (!idsDeCampo.has(condition.field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['logic', i, 'when', j, 'field'],
            message: `A regra usa o campo "${condition.field}", que não existe.`,
          });
        }
      }

      const alvoValido = rule.action === 'skip_to_page' ? idsDePagina.has(rule.target) : idsDeCampo.has(rule.target);
      if (!alvoValido) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['logic', i, 'target'],
          message: `A regra aponta para "${rule.target}", que não existe.`,
        });
      }
    });
  });

export type FormDefinition = z.infer<typeof formSchema>;

// -----------------------------------------------------------------------------
// Tema
// -----------------------------------------------------------------------------

const corSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.');

export const themeSchema = z
  .object({
    primaryColor: corSchema.default('#2563eb'),
    backgroundColor: corSchema.default('#ffffff'),
    textColor: corSchema.default('#111827'),
    fontFamily: z.enum(['inter', 'system', 'serif', 'mono']).default('inter'),
    borderRadius: z.enum(['none', 'small', 'medium', 'large']).default('medium'),
    logoUrl: z.string().url().max(2048).optional(),
    /** Só nos planos Business+. Sanitizado antes de renderizar. */
    customCss: z.string().max(20_000).optional(),
  })
  .strict()
  .default({});

export type FormTheme = z.infer<typeof themeSchema>;

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

export function allFields(form: FormDefinition): FormField[] {
  return form.pages.flatMap((page) => page.fields);
}

export function findField(form: FormDefinition, fieldId: string): FormField | undefined {
  return allFields(form).find((field) => field.id === fieldId);
}

export function countPages(form: FormDefinition): number {
  return form.pages.length;
}

/** Tipos de campo usados que o plano do cliente não libera. */
export function gatedFieldsUsed(form: FormDefinition): Array<{ fieldId: string; feature: string }> {
  return allFields(form)
    .filter((field) => FEATURE_GATED_FIELDS[field.type])
    .map((field) => ({ fieldId: field.id, feature: FEATURE_GATED_FIELDS[field.type] as string }));
}
