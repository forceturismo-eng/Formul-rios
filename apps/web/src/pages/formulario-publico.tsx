import { useEffect, useMemo, useState } from 'react';
import {
  applyCalculations,
  evaluateLogic,
  formatCEP,
  formatDocument,
  validateResponse,
  type FormDefinition,
  type FormField,
  type FormTheme,
  type ResponseValues,
} from '@forms/shared';
import { ApiError, api, uploadFile } from '../lib/api.js';
import { Spinner } from '../components/ui.js';

/**
 * Renderizador público do formulário.
 *
 * Esta tela é a que roda nos domínios dos clientes, e por isso é
 * deliberadamente isolada do resto do app: não importa o store de sessão, não
 * lê cookie, não conhece rota de painel. Ela recebe um schema e devolve uma
 * resposta.
 *
 * A lógica condicional e os cálculos usam as MESMAS funções do backend
 * (`@forms/shared`). É o que impede a classe de bug em que o formulário aceita
 * na tela e o servidor recusa — ou o contrário, que é pior.
 */

interface FormularioPublico {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  version: number;
  definition: FormDefinition;
  theme: FormTheme;
  state: 'open' | 'closed_by_date' | 'closed_by_limit' | 'requires_password' | 'requires_login' | 'paused';
  organization: { name: string; logoUrl: string | null; primaryColor: string | null };
  showBranding: boolean;
}

/**
 * O que o respondente vê quando o formulário não aceita respostas.
 *
 * Nenhuma variação menciona plano, limite ou pagamento — a razão pela qual o
 * formulário parou é assunto entre a plataforma e o cliente (seção 11).
 */
const MENSAGEM_FECHADO: Record<string, string> = {
  closed_by_date: 'Este formulário não está mais recebendo respostas.',
  closed_by_limit: 'Este formulário não está recebendo respostas no momento.',
  paused:
    'Este formulário não está recebendo respostas no momento. Se você precisa entrar em contato, procure a equipe responsável diretamente.',
  requires_login: 'Este formulário é restrito. Entre com sua conta para responder.',
};

export function PaginaFormularioPublico({ slug }: { slug: string }) {
  const [formulario, setFormulario] = useState<FormularioPublico | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [naoEncontrado, setNaoEncontrado] = useState(false);

  useEffect(() => {
    api<FormularioPublico>(`/f/${encodeURIComponent(slug)}`)
      .then(setFormulario)
      .catch(() => setNaoEncontrado(true))
      .finally(() => setCarregando(false));
  }, [slug]);

  // O branding da organização entra por variável CSS — sem `!important` e sem
  // CSS global, que é o requisito do white-label (seção 8.5).
  useEffect(() => {
    if (formulario?.organization.primaryColor) {
      document.documentElement.style.setProperty('--cor-marca', formulario.organization.primaryColor);
    }
    if (formulario) document.title = formulario.title;
  }, [formulario]);

  if (carregando) return <Spinner label="Carregando formulário" />;

  if (naoEncontrado || !formulario) {
    return (
      <Moldura>
        <p className="text-slate-600">Este formulário não está disponível.</p>
      </Moldura>
    );
  }

  if (formulario.state !== 'open' && formulario.state !== 'requires_password') {
    return (
      <Moldura organizacao={formulario.organization}>
        <h1 className="text-xl font-semibold text-slate-900">{formulario.title}</h1>
        <p className="mt-3 text-slate-600">{MENSAGEM_FECHADO[formulario.state]}</p>
      </Moldura>
    );
  }

  return <Formulario formulario={formulario} />;
}

function Moldura({
  children,
  organizacao,
  semMarca,
}: {
  children: React.ReactNode;
  organizacao?: FormularioPublico['organization'];
  semMarca?: boolean;
}) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        {organizacao && (
          <div className="mb-6 flex items-center gap-3">
            {organizacao.logoUrl ? (
              <img src={organizacao.logoUrl} alt={organizacao.name} className="h-9 w-auto" />
            ) : (
              <span className="font-medium text-slate-700">{organizacao.name}</span>
            )}
          </div>
        )}

        <div className="cartao">{children}</div>

        {/* "Powered by" some nos planos Pro+ (seção 8.5). */}
        {!semMarca && (
          <p className="mt-6 text-center text-xs text-slate-400">Formulário criado com Formulários</p>
        )}
      </div>
    </div>
  );
}

function Formulario({ formulario }: { formulario: FormularioPublico }) {
  const [valores, setValores] = useState<ResponseValues>({});
  const [erros, setErros] = useState<Record<string, string[]>>({});
  const [pagina, setPagina] = useState(0);
  const [senha, setSenha] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState<{ mensagem: string; redirecionar?: string } | null>(null);
  const [erroGeral, setErroGeral] = useState<string | null>(null);

  const definicao = formulario.definition;

  // Recalcula a cada tecla: os campos calculados precisam acompanhar o que a
  // pessoa digita, e a lógica condicional decide o que fica visível.
  const comCalculos = useMemo(() => applyCalculations(definicao, valores), [definicao, valores]);
  const logica = useMemo(() => evaluateLogic(definicao, comCalculos), [definicao, comCalculos]);

  const paginaAtual = definicao.pages[pagina];
  const ultimaPagina = pagina === definicao.pages.length - 1;

  const camposVisiveis = (paginaAtual?.fields ?? []).filter(
    (campo) => campo.type !== 'hidden' && !logica.hiddenFields.has(campo.id),
  );

  function definirValor(id: string, valor: unknown): void {
    setValores((atual) => ({ ...atual, [id]: valor as never }));
    // Limpa o erro do campo assim que a pessoa mexe nele: manter o erro
    // vermelho enquanto ela corrige é hostil.
    setErros((atual) => {
      if (!atual[id]) return atual;
      const proximo = { ...atual };
      delete proximo[id];
      return proximo;
    });
  }

  /** Valida só os campos da página atual, para não acusar o que ainda não foi visto. */
  function validarPagina(): boolean {
    const resultado = validateResponse(definicao, comCalculos);
    const idsDaPagina = new Set(camposVisiveis.map((campo) => campo.id));

    const errosDaPagina = Object.fromEntries(
      Object.entries(resultado.errors).filter(([id]) => idsDaPagina.has(id)),
    );

    setErros(errosDaPagina);
    return Object.keys(errosDaPagina).length === 0;
  }

  async function enviar(): Promise<void> {
    if (!validarPagina()) return;

    const resultado = validateResponse(definicao, comCalculos);
    if (!resultado.ok) {
      setErros(resultado.errors);
      // Volta para a primeira página que tem erro, senão a pessoa não vê.
      const primeiroErro = Object.keys(resultado.errors)[0];
      const indice = definicao.pages.findIndex((p) => p.fields.some((c) => c.id === primeiroErro));
      if (indice >= 0) setPagina(indice);
      return;
    }

    setEnviando(true);
    setErroGeral(null);

    try {
      const resposta = await api<{ confirmationMessage: string; redirectUrl?: string }>(
        `/f/${encodeURIComponent(formulario.slug)}/submit`,
        {
          method: 'POST',
          body: {
            values: comCalculos,
            ...(senha ? { password: senha } : {}),
            // Honeypot: sempre vazio para humano, porque o campo é invisível.
            website: '',
          },
        },
      );

      setEnviado({
        mensagem: resposta.confirmationMessage,
        ...(resposta.redirectUrl ? { redirecionar: resposta.redirectUrl } : {}),
      });

      if (resposta.redirectUrl) {
        window.setTimeout(() => {
          window.location.href = resposta.redirectUrl as string;
        }, 1500);
      }
    } catch (problema) {
      if (problema instanceof ApiError) {
        if (problema.code === 'validation_error') setErros(problema.details);
        else setErroGeral(problema.message);
      } else {
        setErroGeral('Não conseguimos enviar sua resposta agora. Tente de novo em instantes.');
      }
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <Moldura organizacao={formulario.organization} semMarca={!formulario.showBranding}>
        <div className="py-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
            ✓
          </div>
          <p className="text-lg font-medium text-slate-900">{enviado.mensagem}</p>
          {enviado.redirecionar && <p className="mt-2 text-sm text-slate-500">Redirecionando…</p>}
        </div>
      </Moldura>
    );
  }

  return (
    <Moldura organizacao={formulario.organization} semMarca={!formulario.showBranding}>
      <form
        onSubmit={(evento) => {
          evento.preventDefault();
          if (ultimaPagina) void enviar();
          else if (validarPagina()) setPagina((atual) => atual + 1);
        }}
        noValidate
      >
        <h1 className="text-xl font-semibold text-slate-900">{formulario.title}</h1>
        {formulario.description && <p className="mt-2 text-slate-600">{formulario.description}</p>}

        {definicao.settings.showProgressBar && definicao.pages.length > 1 && (
          <div className="mt-5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${((pagina + 1) / definicao.pages.length) * 100}%`,
                  backgroundColor: 'var(--cor-marca)',
                }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Página {pagina + 1} de {definicao.pages.length}
            </p>
          </div>
        )}

        {paginaAtual?.title && <h2 className="mt-8 font-medium text-slate-900">{paginaAtual.title}</h2>}
        {paginaAtual?.description && <p className="mt-1 text-sm text-slate-600">{paginaAtual.description}</p>}

        <div className="mt-6 space-y-5">
          {camposVisiveis.map((campo) => (
            <Campo
              key={campo.id}
              campo={campo}
              valor={comCalculos[campo.id]}
              erros={erros[campo.id] ?? []}
              obrigatorio={campo.required || logica.extraRequiredFields.has(campo.id)}
              slug={formulario.slug}
              aoMudar={(valor) => definirValor(campo.id, valor)}
            />
          ))}
        </div>

        {/*
          Honeypot: invisível para humano, irresistível para robô que preenche
          tudo. Fica fora da ordem de tabulação e escondido de leitores de tela.
        */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute left-[-9999px] h-0 w-0 opacity-0"
        />

        {formulario.state === 'requires_password' && (
          <div className="mt-6">
            <label className="rotulo" htmlFor="senha-formulario">
              Senha do formulário
            </label>
            <input
              id="senha-formulario"
              type="password"
              className="campo"
              value={senha}
              onChange={(evento) => setSenha(evento.target.value)}
            />
            {erros['password'] && <p className="erro-campo">{erros['password'][0]}</p>}
          </div>
        )}

        {erroGeral && (
          <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {erroGeral}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between gap-3">
          {pagina > 0 ? (
            <button type="button" className="botao-secundario" onClick={() => setPagina((atual) => atual - 1)}>
              Voltar
            </button>
          ) : (
            <span />
          )}

          <button type="submit" className="botao-primario" disabled={enviando}>
            {enviando ? 'Enviando…' : ultimaPagina ? definicao.settings.submitLabel : 'Continuar'}
          </button>
        </div>
      </form>
    </Moldura>
  );
}

function Campo({
  campo,
  valor,
  erros,
  obrigatorio,
  slug,
  aoMudar,
}: {
  campo: FormField;
  valor: unknown;
  erros: string[];
  obrigatorio: boolean;
  slug: string;
  aoMudar: (valor: unknown) => void;
}) {
  const idCampo = `campo-${campo.id}`;
  const invalido = erros.length > 0;
  const classe = `campo ${invalido ? 'border-red-400 focus:ring-red-100' : ''}`;

  return (
    <div>
      <label className="rotulo" htmlFor={idCampo}>
        {campo.label}
        {obrigatorio && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {campo.description && <p className="mb-1.5 text-sm text-slate-500">{campo.description}</p>}

      <ControleDoCampo
        campo={campo}
        idCampo={idCampo}
        classe={classe}
        valor={valor}
        slug={slug}
        aoMudar={aoMudar}
      />

      {erros.map((erro) => (
        <p key={erro} className="erro-campo">
          {erro}
        </p>
      ))}
    </div>
  );
}

function ControleDoCampo({
  campo,
  idCampo,
  classe,
  valor,
  slug,
  aoMudar,
}: {
  campo: FormField;
  idCampo: string;
  classe: string;
  valor: unknown;
  slug: string;
  aoMudar: (valor: unknown) => void;
}) {
  const texto = typeof valor === 'string' || typeof valor === 'number' ? String(valor) : '';

  switch (campo.type) {
    case 'long_text':
      return (
        <textarea
          id={idCampo}
          rows={4}
          className={classe}
          placeholder={campo.placeholder}
          value={texto}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      );

    case 'cpf_cnpj':
      return (
        <input
          id={idCampo}
          inputMode="numeric"
          className={classe}
          placeholder={campo.placeholder ?? '000.000.000-00'}
          value={texto ? formatDocument(texto) : ''}
          onChange={(evento) => aoMudar(evento.target.value.replace(/\D/g, ''))}
        />
      );

    case 'cep':
      return (
        <input
          id={idCampo}
          inputMode="numeric"
          className={classe}
          placeholder="00000-000"
          value={texto ? formatCEP(texto) : ''}
          onChange={(evento) => aoMudar(evento.target.value.replace(/\D/g, '').slice(0, 8))}
        />
      );

    case 'phone_br':
      return (
        <input
          id={idCampo}
          inputMode="tel"
          className={classe}
          placeholder="(00) 00000-0000"
          value={formatarTelefone(texto)}
          onChange={(evento) => aoMudar(evento.target.value.replace(/\D/g, '').slice(0, 11))}
        />
      );

    case 'number':
    case 'currency':
      return (
        <input
          id={idCampo}
          type="number"
          step={campo.type === 'currency' ? '0.01' : 'any'}
          className={classe}
          placeholder={campo.placeholder}
          // Moeda é guardada em centavos; na tela ela aparece em reais.
          value={campo.type === 'currency' && typeof valor === 'number' ? valor / 100 : texto}
          onChange={(evento) => aoMudar(evento.target.value)}
          readOnly={Boolean(campo.calculation)}
        />
      );

    case 'date':
    case 'time':
    case 'datetime':
      return (
        <input
          id={idCampo}
          type={campo.type === 'datetime' ? 'datetime-local' : campo.type}
          className={classe}
          value={texto}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      );

    case 'dropdown':
      return (
        <select id={idCampo} className={classe} value={texto} onChange={(evento) => aoMudar(evento.target.value)}>
          <option value="">Selecione…</option>
          {campo.options?.map((opcao) => (
            <option key={opcao.value} value={opcao.value}>
              {opcao.label}
            </option>
          ))}
        </select>
      );

    case 'single_select':
      return (
        <div className="space-y-2">
          {campo.options?.map((opcao) => (
            <label key={opcao.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
              <input
                type="radio"
                name={idCampo}
                value={opcao.value}
                checked={texto === opcao.value}
                onChange={() => aoMudar(opcao.value)}
                className="h-4 w-4"
              />
              {opcao.label}
            </label>
          ))}
        </div>
      );

    case 'multi_select': {
      const selecionados = Array.isArray(valor) ? (valor as string[]) : [];
      return (
        <div className="space-y-2">
          {campo.options?.map((opcao) => (
            <label key={opcao.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={selecionados.includes(opcao.value)}
                onChange={(evento) =>
                  aoMudar(
                    evento.target.checked
                      ? [...selecionados, opcao.value]
                      : selecionados.filter((item) => item !== opcao.value),
                  )
                }
                className="h-4 w-4"
              />
              {opcao.label}
            </label>
          ))}
        </div>
      );
    }

    case 'scale':
    case 'nps': {
      const minimo = campo.scaleMin ?? (campo.type === 'nps' ? 0 : 1);
      const maximo = campo.scaleMax ?? (campo.type === 'nps' ? 10 : 5);
      const escala = Array.from({ length: maximo - minimo + 1 }, (_, i) => minimo + i);

      return (
        <div>
          <div className="flex flex-wrap gap-2">
            {escala.map((nota) => (
              <button
                key={nota}
                type="button"
                onClick={() => aoMudar(nota)}
                className={`h-10 w-10 rounded-lg border text-sm font-medium transition-colors ${
                  valor === nota
                    ? 'border-transparent text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
                style={valor === nota ? { backgroundColor: 'var(--cor-marca)' } : undefined}
              >
                {nota}
              </button>
            ))}
          </div>
          {(campo.scaleMinLabel || campo.scaleMaxLabel) && (
            <div className="mt-2 flex justify-between text-xs text-slate-500">
              <span>{campo.scaleMinLabel}</span>
              <span>{campo.scaleMaxLabel}</span>
            </div>
          )}
        </div>
      );
    }

    case 'file_upload':
      return <CampoArquivo campo={campo} valor={valor} slug={slug} aoMudar={aoMudar} />;

    case 'address': {
      const endereco = (valor && typeof valor === 'object' ? valor : {}) as Record<string, string>;
      const atualizar = (chave: string, novo: string): void => aoMudar({ ...endereco, [chave]: novo });

      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className={classe}
            placeholder="CEP"
            value={endereco['zip'] ?? ''}
            onChange={(e) => atualizar('zip', e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
          <input
            className={classe}
            placeholder="Rua"
            value={endereco['street'] ?? ''}
            onChange={(e) => atualizar('street', e.target.value)}
          />
          <input
            className={classe}
            placeholder="Número"
            value={endereco['number'] ?? ''}
            onChange={(e) => atualizar('number', e.target.value)}
          />
          <input
            className={classe}
            placeholder="Complemento"
            value={endereco['complement'] ?? ''}
            onChange={(e) => atualizar('complement', e.target.value)}
          />
          <input
            className={classe}
            placeholder="Bairro"
            value={endereco['district'] ?? ''}
            onChange={(e) => atualizar('district', e.target.value)}
          />
          <input
            className={classe}
            placeholder="Cidade"
            value={endereco['city'] ?? ''}
            onChange={(e) => atualizar('city', e.target.value)}
          />
          <input
            className={classe}
            placeholder="UF"
            maxLength={2}
            value={endereco['state'] ?? ''}
            onChange={(e) => atualizar('state', e.target.value.toUpperCase())}
          />
        </div>
      );
    }

    case 'matrix': {
      const matriz = (valor && typeof valor === 'object' ? valor : {}) as Record<string, string>;

      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th />
                {campo.columns?.map((coluna) => (
                  <th key={coluna.value} className="px-2 py-2 text-center text-xs font-medium text-slate-600">
                    {coluna.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campo.rows?.map((linha) => (
                <tr key={linha.value} className="border-t border-slate-100">
                  <td className="py-2 pr-3 text-slate-700">{linha.label}</td>
                  {campo.columns?.map((coluna) => (
                    <td key={coluna.value} className="px-2 py-2 text-center">
                      <input
                        type="radio"
                        name={`${idCampo}-${linha.value}`}
                        checked={matriz[linha.value] === coluna.value}
                        onChange={() => aoMudar({ ...matriz, [linha.value]: coluna.value })}
                        className="h-4 w-4"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'signature':
      return (
        <input
          id={idCampo}
          className={classe}
          placeholder="Digite seu nome completo para assinar"
          value={texto}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      );

    default:
      return (
        <input
          id={idCampo}
          type={campo.type === 'email' ? 'email' : 'text'}
          className={classe}
          placeholder={campo.placeholder}
          value={texto}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      );
  }
}

function CampoArquivo({
  campo,
  valor,
  slug,
  aoMudar,
}: {
  campo: FormField;
  valor: unknown;
  slug: string;
  aoMudar: (valor: unknown) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [nomes, setNomes] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const ids = Array.isArray(valor) ? (valor as string[]) : [];

  async function enviar(arquivo: File): Promise<void> {
    setEnviando(true);
    setErro(null);
    try {
      // O upload acontece ANTES da submissão: o campo guarda o id do arquivo,
      // e a validação de MIME e tamanho já rodou no servidor.
      const enviado = await uploadFile<{ id: string; filename: string }>(
        `/f/${encodeURIComponent(slug)}/upload`,
        arquivo,
      );
      aoMudar([...ids, enviado.id]);
      setNomes((atual) => [...atual, enviado.filename]);
    } catch (problema) {
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos enviar esse arquivo.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div>
      <input
        type="file"
        disabled={enviando}
        onChange={(evento) => {
          const arquivo = evento.target.files?.[0];
          if (arquivo) void enviar(arquivo);
          evento.target.value = '';
        }}
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200"
      />
      {enviando && <p className="mt-2 text-sm text-slate-500">Enviando…</p>}
      {erro && <p className="erro-campo">{erro}</p>}

      {nomes.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-slate-600">
          {nomes.map((nome, i) => (
            <li key={`${nome}-${i}`} className="flex items-center gap-2">
              <span aria-hidden="true">📎</span>
              {nome}
            </li>
          ))}
        </ul>
      )}

      {campo.validation?.maxFiles && (
        <p className="mt-1.5 text-xs text-slate-500">Até {campo.validation.maxFiles} arquivo(s).</p>
      )}
    </div>
  );
}

function formatarTelefone(digitos: string): string {
  if (digitos.length <= 2) return digitos;
  if (digitos.length <= 6) return `(${digitos.slice(0, 2)}) ${digitos.slice(2)}`;
  if (digitos.length <= 10) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7, 11)}`;
}
