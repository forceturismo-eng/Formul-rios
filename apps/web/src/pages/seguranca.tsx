import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { MensagemDeErro, Spinner } from '../components/ui.js';

/**
 * Segurança da conta: verificação em duas etapas.
 *
 * Duas decisões de interface, e as duas são sobre o momento ruim — quando a
 * pessoa perde o celular:
 *
 *  - Os códigos de recuperação aparecem UMA vez, num painel que diz o que se
 *    perde ao fechar. Depois disso o banco só tem o hash deles.
 *  - A tela mostra quantos ainda restam. Descobrir que acabaram no momento em
 *    que se precisa deles é tarde demais.
 */

interface EstadoDoMfa {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export function PaginaSeguranca() {
  const cliente = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const [configuracao, setConfiguracao] = useState<{ secret: string; uri: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [codigosDeRecuperacao, setCodigosDeRecuperacao] = useState<string[] | null>(null);
  const [senha, setSenha] = useState('');

  const { data: estado, isLoading } = useQuery({
    queryKey: ['mfa'],
    queryFn: () => api<EstadoDoMfa>('/v1/auth/mfa'),
  });

  function aoFalhar(padrao: string) {
    return (problema: unknown) => setErro(problema instanceof ApiError ? problema.message : padrao);
  }

  const comecar = useMutation({
    mutationFn: () => api<{ secret: string; uri: string }>('/v1/auth/mfa/setup', { method: 'POST' }),
    onSuccess: (resultado) => {
      setErro(null);
      setConfiguracao(resultado);
    },
    onError: aoFalhar('Não conseguimos começar a configuração.'),
  });

  const ativar = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/v1/auth/mfa/activate', { method: 'POST', body: { code: codigo } }),
    onSuccess: (resultado) => {
      setErro(null);
      setConfiguracao(null);
      setCodigo('');
      setCodigosDeRecuperacao(resultado.recoveryCodes);
      void cliente.invalidateQueries({ queryKey: ['mfa'] });
    },
    onError: aoFalhar('Código inválido.'),
  });

  const desligar = useMutation({
    mutationFn: () => api('/v1/auth/mfa/disable', { method: 'POST', body: { password: senha } }),
    onSuccess: () => {
      setErro(null);
      setSenha('');
      void cliente.invalidateQueries({ queryKey: ['mfa'] });
    },
    onError: aoFalhar('Não conseguimos desligar.'),
  });

  const novosCodigos = useMutation({
    mutationFn: () =>
      api<{ recoveryCodes: string[] }>('/v1/auth/mfa/recovery-codes', { method: 'POST', body: { password: senha } }),
    onSuccess: (resultado) => {
      setErro(null);
      setSenha('');
      setCodigosDeRecuperacao(resultado.recoveryCodes);
      void cliente.invalidateQueries({ queryKey: ['mfa'] });
    },
    onError: aoFalhar('Não conseguimos gerar novos códigos.'),
  });

  if (isLoading || !estado) {
    return (
      <LayoutPainel>
        <Spinner />
      </LayoutPainel>
    );
  }

  return (
    <LayoutPainel>
      <TituloDaPagina titulo="Segurança" descricao="Como você entra na sua conta." />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {codigosDeRecuperacao && (
        <CodigosDeRecuperacao codigos={codigosDeRecuperacao} aoFechar={() => setCodigosDeRecuperacao(null)} />
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-semibold text-slate-900">Verificação em duas etapas</h2>
            <p className="mt-1 text-sm text-slate-600">
              Além da senha, entrar passa a pedir um código de seis dígitos gerado no seu celular. Se a sua senha
              vazar, ela sozinha não abre a conta.
            </p>

            {estado.enabled && (
              <p className="mt-2 text-sm text-emerald-800">
                Ativa desde {new Intl.DateTimeFormat('pt-BR').format(new Date(estado.enabledAt as string))} ·{' '}
                {estado.recoveryCodesLeft} código(s) de recuperação restante(s)
                {estado.recoveryCodesLeft <= 2 && (
                  // Descobrir que acabaram no momento de precisar deles é tarde.
                  <strong className="ml-1 text-amber-800">— gere novos antes que acabem</strong>
                )}
              </p>
            )}
          </div>

          {!estado.enabled && !configuracao && (
            <button type="button" className="botao-primario" disabled={comecar.isPending} onClick={() => comecar.mutate()}>
              Ativar
            </button>
          )}
        </div>

        {configuracao && (
          <div className="mt-5 space-y-4 border-t border-slate-200 pt-5">
            <p className="text-sm text-slate-700">
              Cadastre este código no seu aplicativo autenticador (Google Authenticator, Authy, 1Password) e
              confirme com o primeiro número que ele mostrar.
            </p>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Chave</p>
              <code className="mt-1 block overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm">
                {configuracao.secret}
              </code>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Ou use este endereço</p>
              <p className="mt-1 break-all text-xs text-slate-500">{configuracao.uri}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-widest"
                placeholder="000000"
                inputMode="numeric"
                maxLength={6}
                value={codigo}
                onChange={(evento) => setCodigo(evento.target.value)}
              />
              <button type="button" className="botao-primario" disabled={ativar.isPending} onClick={() => ativar.mutate()}>
                {ativar.isPending ? 'Conferindo…' : 'Confirmar'}
              </button>
              <button type="button" className="botao-secundario" onClick={() => setConfiguracao(null)}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {estado.enabled && (
          <div className="mt-5 space-y-3 border-t border-slate-200 pt-5">
            <p className="text-sm text-slate-600">
              Para desligar ou gerar novos códigos, confirme sua senha. A sessão sozinha não basta — ela pode ter
              sido roubada, que é justamente o caso contra o qual esta proteção existe.
            </p>

            <div className="flex flex-wrap gap-2">
              <input
                className="min-w-56 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                type="password"
                autoComplete="current-password"
                placeholder="Sua senha"
                value={senha}
                onChange={(evento) => setSenha(evento.target.value)}
              />

              <button
                type="button"
                className="botao-secundario"
                disabled={novosCodigos.isPending || senha === ''}
                onClick={() => novosCodigos.mutate()}
              >
                Gerar novos códigos
              </button>

              <button
                type="button"
                className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                disabled={desligar.isPending || senha === ''}
                onClick={() => {
                  if (window.confirm('Desligar a verificação em duas etapas? Sua conta fica só com a senha.')) {
                    desligar.mutate();
                  }
                }}
              >
                Desligar
              </button>
            </div>
          </div>
        )}
      </section>
    </LayoutPainel>
  );
}

/**
 * Painel dos códigos de recuperação.
 *
 * Aparece uma vez. O botão de fechar diz o que se perde, porque depois daqui o
 * banco só tem o hash deles — exatamente como uma senha.
 */
function CodigosDeRecuperacao({ codigos, aoFechar }: { codigos: string[]; aoFechar: () => void }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-5">
      <p className="font-medium text-amber-900">Guarde seus códigos de recuperação</p>
      <p className="mt-1 text-sm text-amber-900">
        É assim que você entra se perder o celular. Cada código serve uma vez. Guarde-os fora do aparelho — num
        gerenciador de senhas ou impressos.
      </p>

      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {codigos.map((codigo) => (
          <li
            key={codigo}
            className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-center font-mono text-sm"
          >
            {codigo}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => {
            void navigator.clipboard?.writeText(codigos.join('\n'));
            setCopiado(true);
          }}
        >
          {copiado ? 'Copiado' : 'Copiar todos'}
        </button>
        <button
          type="button"
          className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-white/60"
          onClick={aoFechar}
        >
          Já guardei, pode fechar
        </button>
      </div>
    </div>
  );
}
