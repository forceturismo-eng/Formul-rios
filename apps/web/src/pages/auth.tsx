import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '@forms/shared';
import { ApiError, api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Link, useNavigate } from '../lib/router.js';
import { MensagemDeErro } from '../components/ui.js';

/**
 * Entrada e cadastro.
 *
 * Os schemas de validação vêm de `@forms/shared` — os MESMOS que o backend
 * usa. O formulário valida para dar retorno rápido; quem decide é o servidor.
 * Um schema duplicado aqui viraria, com o tempo, duas regras diferentes.
 */

function Moldura({ titulo, subtitulo, children }: { titulo: string; subtitulo: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 block text-center text-lg font-semibold text-slate-900">
          Formulários
        </Link>

        <div className="cartao">
          <h1 className="text-xl font-semibold text-slate-900">{titulo}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitulo}</p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function PaginaLogin() {
  const entrar = useSession((estado) => estado.entrar);
  const navigate = useNavigate();
  const [erro, setErro] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  async function aoEnviar(dados: LoginInput): Promise<void> {
    setErro(null);
    try {
      await entrar(dados.email, dados.password);
      navigate('/formularios');
    } catch (problema) {
      setErro(
        problema instanceof ApiError
          ? problema.message
          : 'Não conseguimos entrar agora. Tente de novo em instantes.',
      );
    }
  }

  return (
    <Moldura titulo="Entrar" subtitulo="Acesse o painel da sua empresa.">
      <form onSubmit={handleSubmit(aoEnviar)} className="space-y-4" noValidate>
        {erro && <MensagemDeErro>{erro}</MensagemDeErro>}

        <div>
          <label className="rotulo" htmlFor="email">
            E-mail
          </label>
          <input id="email" type="email" autoComplete="email" className="campo" {...register('email')} />
          {errors.email && <p className="erro-campo">{errors.email.message}</p>}
        </div>

        <div>
          <label className="rotulo" htmlFor="password">
            Senha
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="campo"
            {...register('password')}
          />
          {errors.password && <p className="erro-campo">{errors.password.message}</p>}
        </div>

        <button type="submit" className="botao-primario w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Entrando…' : 'Entrar na minha conta'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        Ainda não tem conta?{' '}
        <Link to="/criar-conta" className="font-medium text-slate-900 hover:underline">
          Criar conta grátis
        </Link>
      </p>
    </Moldura>
  );
}

export function PaginaRegistro() {
  const registrar = useSession((estado) => estado.registrar);
  const navigate = useNavigate();
  const [erro, setErro] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  async function aoEnviar(dados: RegisterInput): Promise<void> {
    setErro(null);
    try {
      await registrar(dados);
      navigate('/formularios');
    } catch (problema) {
      if (problema instanceof ApiError) {
        // Erros de campo do servidor voltam para o campo certo — inclusive o
        // de senha vazada, que só o backend sabe verificar.
        const porCampo = problema.fieldErrors();
        for (const { field, message } of porCampo) {
          setError(field as keyof RegisterInput, { message });
        }
        if (porCampo.length === 0) setErro(problema.message);
      } else {
        setErro('Não conseguimos criar sua conta agora. Tente de novo em instantes.');
      }
    }
  }

  return (
    <Moldura titulo="Criar conta" subtitulo="14 dias com tudo liberado, sem cartão de crédito.">
      <form onSubmit={handleSubmit(aoEnviar)} className="space-y-4" noValidate>
        {erro && <MensagemDeErro>{erro}</MensagemDeErro>}

        <div>
          <label className="rotulo" htmlFor="organizationName">
            Nome da empresa
          </label>
          <input id="organizationName" className="campo" {...register('organizationName')} />
          {errors.organizationName && <p className="erro-campo">{errors.organizationName.message}</p>}
        </div>

        <div>
          <label className="rotulo" htmlFor="name">
            Seu nome
          </label>
          <input id="name" autoComplete="name" className="campo" {...register('name')} />
          {errors.name && <p className="erro-campo">{errors.name.message}</p>}
        </div>

        <div>
          <label className="rotulo" htmlFor="email-registro">
            E-mail
          </label>
          <input id="email-registro" type="email" autoComplete="email" className="campo" {...register('email')} />
          {errors.email && <p className="erro-campo">{errors.email.message}</p>}
        </div>

        <div>
          <label className="rotulo" htmlFor="senha-registro">
            Senha
          </label>
          <input
            id="senha-registro"
            type="password"
            autoComplete="new-password"
            className="campo"
            {...register('password')}
          />
          {errors.password ? (
            <p className="erro-campo">{errors.password.message}</p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-500">Pelo menos 10 caracteres, combinando letras e números.</p>
          )}
        </div>

        <button type="submit" className="botao-primario w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Criando…' : 'Criar minha conta grátis'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        Já tem conta?{' '}
        <Link to="/entrar" className="font-medium text-slate-900 hover:underline">
          Entrar
        </Link>
      </p>
    </Moldura>
  );
}

export function PaginaVerificarEmail() {
  const [estado, setEstado] = useState<'confirmando' | 'ok' | 'erro'>('confirmando');
  const [mensagem, setMensagem] = useState('');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setEstado('erro');
      setMensagem('O link de confirmação está incompleto.');
      return;
    }

    api('/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setEstado('ok'))
      .catch((problema: unknown) => {
        setEstado('erro');
        setMensagem(
          problema instanceof ApiError ? problema.message : 'Não conseguimos confirmar seu e-mail agora.',
        );
      });
  }, []);

  return (
    <Moldura
      titulo={estado === 'ok' ? 'E-mail confirmado' : 'Confirmando seu e-mail'}
      subtitulo={estado === 'ok' ? 'Tudo certo. Sua conta está liberada.' : 'Isso leva só um instante.'}
    >
      {estado === 'erro' && <MensagemDeErro>{mensagem}</MensagemDeErro>}

      {estado === 'ok' && (
        <Link to="/formularios" className="botao-primario w-full">
          Ir para meus formulários
        </Link>
      )}
    </Moldura>
  );
}
