import { createClient } from '@supabase/supabase-js';
import {
  AUTHORIZATION_STORAGE_KEY,
  OAUTH_SESSION_STORAGE_KEY,
  decideAuthorization,
  loadConsent,
  parseAuthorizationId,
  parseScopes,
  signInForAuthorization,
  type ConsentDetails,
  type OAuthPort,
} from './oauth-flow.js';

interface PublicConfig {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly environment: string;
  readonly basePath: string;
}

interface LogoutPort {
  signOut(): Promise<unknown>;
}

function requiredDataset(root: HTMLElement, key: keyof DOMStringMap): string {
  const value = root.dataset[key];
  if (value === undefined || value.length === 0 || value.length > 2_048) throw new Error('Invalid public configuration');
  return value;
}

function readConfig(root: HTMLElement): PublicConfig {
  const supabaseUrl = requiredDataset(root, 'supabaseUrl');
  const publishableKey = requiredDataset(root, 'supabasePublishableKey');
  const environment = requiredDataset(root, 'environment');
  const basePath = requiredDataset(root, 'basePath');
  const parsedUrl = new URL(supabaseUrl);
  if (parsedUrl.protocol !== 'https:'
    || parsedUrl.username.length > 0
    || parsedUrl.password.length > 0
    || parsedUrl.search.length > 0
    || parsedUrl.hash.length > 0
    || !parsedUrl.hostname.endsWith('.supabase.co')
    || environment !== 'staging'
    || basePath !== '/oauth'
    || !/^(?:sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.test(publishableKey)) {
    throw new Error('Invalid public configuration');
  }
  return { supabaseUrl: parsedUrl.origin, publishableKey, environment, basePath };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function renderShell(root: HTMLElement, title: string, description: string): HTMLElement {
  root.replaceChildren();
  const card = element('section', undefined, 'card');
  const eyebrow = element('p', 'Crônicas de Outro Mundo', 'eyebrow');
  const heading = element('h1', title);
  const copy = element('p', description, 'description');
  card.append(eyebrow, heading, copy);
  root.append(card);
  return card;
}

function renderSafeError(root: HTMLElement, message = 'Não foi possível concluir esta solicitação. Tente novamente.'): void {
  const card = renderShell(root, 'Acesso indisponível', message);
  const link = element('a', 'Voltar ao login', 'button secondary');
  link.href = '/oauth/login';
  card.append(link);
}

function consentUrl(basePath: string, authorizationId: string): string {
  const search = new URLSearchParams({ authorization_id: authorizationId });
  return `${basePath}/consent?${search.toString()}`;
}

function loginUrl(basePath: string, authorizationId: string): string {
  const search = new URLSearchParams({ authorization_id: authorizationId });
  return `${basePath}/login?${search.toString()}`;
}

async function renderLogin(root: HTMLElement, config: PublicConfig, port: OAuthPort): Promise<void> {
  const queryId = parseAuthorizationId(new URL(window.location.href).searchParams.get('authorization_id'));
  const storedId = parseAuthorizationId(sessionStorage.getItem(AUTHORIZATION_STORAGE_KEY));
  const authorizationId = queryId ?? storedId;
  if (authorizationId !== undefined) sessionStorage.setItem(AUTHORIZATION_STORAGE_KEY, authorizationId);

  const card = renderShell(root, 'Entrar para continuar', 'Use somente a conta de teste autorizada para este ambiente.');
  const form = element('form');
  form.autocomplete = 'on';
  const emailLabel = element('label', 'E-mail');
  const email = element('input');
  email.type = 'email';
  email.name = 'email';
  email.autocomplete = 'username';
  email.required = true;
  email.maxLength = 320;
  emailLabel.append(email);
  const passwordLabel = element('label', 'Senha');
  const password = element('input');
  password.type = 'password';
  password.name = 'password';
  password.autocomplete = 'current-password';
  password.required = true;
  password.maxLength = 1_024;
  passwordLabel.append(password);
  const feedback = element('p', '', 'feedback');
  feedback.setAttribute('role', 'status');
  const submit = element('button', 'Entrar', 'button');
  submit.type = 'submit';
  form.append(emailLabel, passwordLabel, feedback, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = 'Validando acesso…';
    void signInForAuthorization(port, email.value.trim(), password.value).then((success) => {
      password.value = '';
      if (!success) {
        feedback.textContent = 'Não foi possível entrar com essas credenciais.';
        submit.disabled = false;
        return;
      }
      const target = authorizationId === undefined ? `${config.basePath}/consent` : consentUrl(config.basePath, authorizationId);
      window.location.assign(target);
    }).catch(() => {
      password.value = '';
      feedback.textContent = 'Não foi possível entrar com essas credenciais.';
      submit.disabled = false;
    });
  });
  card.append(form);
}

function addLogout(card: HTMLElement, logoutPort: LogoutPort, config: PublicConfig): void {
  const logout = element('button', 'Sair desta aba', 'link-button');
  logout.type = 'button';
  logout.addEventListener('click', () => {
    logout.disabled = true;
    void logoutPort.signOut().finally(() => {
      sessionStorage.removeItem(AUTHORIZATION_STORAGE_KEY);
      sessionStorage.removeItem(OAUTH_SESSION_STORAGE_KEY);
      window.location.assign(`${config.basePath}/login`);
    });
  });
  card.append(logout);
}

function renderConsentDetails(
  root: HTMLElement,
  config: PublicConfig,
  port: OAuthPort,
  logoutPort: LogoutPort,
  authorizationId: string,
  details: ConsentDetails,
): void {
  const card = renderShell(root, 'Autorizar acesso', 'Revise a aplicação e as permissões antes de continuar.');
  const definition = element('dl', undefined, 'details');
  for (const [label, value] of [
    ['Aplicação', details.client.name],
    ['Retorno', details.redirect_uri],
    ['Ambiente', config.environment],
  ]) {
    definition.append(element('dt', label), element('dd', value));
  }
  const scopes = parseScopes(details.scope);
  const scopeTitle = element('h2', 'Permissões solicitadas');
  const scopeList = element('ul', undefined, 'scopes');
  for (const scope of scopes.length === 0 ? ['Nenhuma permissão adicional informada'] : scopes) {
    scopeList.append(element('li', scope));
  }
  const feedback = element('p', '', 'feedback');
  feedback.setAttribute('role', 'status');
  const actions = element('div', undefined, 'actions');
  const deny = element('button', 'Negar', 'button secondary');
  const approve = element('button', 'Autorizar', 'button');
  deny.type = 'button';
  approve.type = 'button';
  const decide = (decision: 'approve' | 'deny') => {
    deny.disabled = true;
    approve.disabled = true;
    feedback.textContent = decision === 'approve' ? 'Autorizando…' : 'Negando acesso…';
    void decideAuthorization(port, decision, authorizationId, details.redirect_uri).then((redirectUrl) => {
      if (redirectUrl === undefined) {
        feedback.textContent = 'Não foi possível concluir esta solicitação.';
        deny.disabled = false;
        approve.disabled = false;
        return;
      }
      sessionStorage.removeItem(AUTHORIZATION_STORAGE_KEY);
      window.location.assign(redirectUrl);
    }).catch(() => {
      feedback.textContent = 'Não foi possível concluir esta solicitação.';
      deny.disabled = false;
      approve.disabled = false;
    });
  };
  deny.addEventListener('click', () => decide('deny'));
  approve.addEventListener('click', () => decide('approve'));
  actions.append(deny, approve);
  card.append(definition, scopeTitle, scopeList, feedback, actions);
  addLogout(card, logoutPort, config);
}

async function renderConsent(
  root: HTMLElement,
  config: PublicConfig,
  port: OAuthPort,
  logoutPort: LogoutPort,
): Promise<void> {
  const authorizationId = parseAuthorizationId(new URL(window.location.href).searchParams.get('authorization_id'));
  if (authorizationId === undefined) {
    renderSafeError(root, 'A solicitação de autorização está ausente ou é inválida.');
    return;
  }
  sessionStorage.setItem(AUTHORIZATION_STORAGE_KEY, authorizationId);
  const card = renderShell(root, 'Validando solicitação', 'Aguarde enquanto verificamos sua sessão.');
  const result = await loadConsent(port, authorizationId);
  if (result.kind === 'login_required') {
    window.location.assign(loginUrl(config.basePath, authorizationId));
    return;
  }
  if (result.kind === 'redirect') {
    sessionStorage.removeItem(AUTHORIZATION_STORAGE_KEY);
    window.location.assign(result.redirectUrl);
    return;
  }
  if (result.kind === 'error') {
    renderSafeError(root);
    return;
  }
  card.remove();
  renderConsentDetails(root, config, port, logoutPort, authorizationId, result.details);
}

async function main(): Promise<void> {
  const root = document.getElementById('oauth-app');
  if (!(root instanceof HTMLElement)) return;
  try {
    const config = readConfig(root);
    const client = createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storageKey: OAUTH_SESSION_STORAGE_KEY,
        storage: window.sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    const port: OAuthPort = {
      signInWithPassword: (credentials) => client.auth.signInWithPassword(credentials),
      getUser: () => client.auth.getUser(),
      getAuthorizationDetails: (authorizationId) => client.auth.oauth.getAuthorizationDetails(authorizationId),
      approveAuthorization: (authorizationId) => client.auth.oauth.approveAuthorization(authorizationId),
      denyAuthorization: (authorizationId) => client.auth.oauth.denyAuthorization(authorizationId),
    };
    const logoutPort: LogoutPort = {
      signOut: () => client.auth.signOut({ scope: 'local' }),
    };
    if (window.location.pathname === `${config.basePath}/login`) {
      await renderLogin(root, config, port);
      return;
    }
    if (window.location.pathname === `${config.basePath}/consent`) {
      await renderConsent(root, config, port, logoutPort);
      return;
    }
    renderSafeError(root);
  } catch {
    renderSafeError(root);
  }
}

void main();
