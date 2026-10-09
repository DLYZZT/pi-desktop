import { useState, useEffect, useCallback, useRef } from "react";
import { SectionTitle } from "../form-controls";
import { useI18n } from "@/i18n";
import { call, subscribeAuthLogin } from "@/lib/api-client";
import type { ProviderStatus as OAuthProvider, LoginProgressEvent } from "@contract/types";
import { type ModelSelectionControl, ManagedModelsControl } from "./ManagedModelsControl";
import { AuthReplacementNotice } from "./AuthReplacementNotice";
import type { CredentialMutationOptions } from "@contract/auth";
import { oauthProviderName, authPromptLabel } from "./provider-display";

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | {
      phase: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string; secret: boolean }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success"; message?: string; warning?: boolean }
  | { phase: "error"; message: string };

export function OAuthDetail({
  provider,
  authType = "oauth",
  onRefresh,
  onReloadCredentials,
  modelSelection,
}: {
  provider: OAuthProvider;
  authType?: "oauth" | "api_key";
  onRefresh: () => void;
  onReloadCredentials?: () => void;
  modelSelection: ModelSelectionControl;
}) {
  const { t } = useI18n();
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const [replacement, setReplacement] = useState<{ version?: string } | null>(null);
  const progressUnsubRef = useRef<(() => void) | null>(null);
  const challengeRef = useRef<string | null>(null);
  const submissionRef = useRef<{ attempt: number; token: string } | null>(null);
  const loginAttemptRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeProgress = useCallback(() => {
    const off = progressUnsubRef.current;
    progressUnsubRef.current = null;
    submissionRef.current = null;
    off?.();
  }, []);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state on entry/provider changes. The outgoing effect owns cancellation
  // for its captured provider, so a replacement provider is never cancelled.
  useEffect(() => {
    const providerId = provider.id;
    loginAttemptRef.current += 1;
    setLoginState({ phase: "idle" });
    setInputValue("");
    setReplacement(null);
    closeProgress();
    challengeRef.current = null;
    return () => {
      loginAttemptRef.current += 1;
      closeProgress();
      challengeRef.current = null;
      void call("auth.loginCancel", { provider: providerId }).catch(() => {});
    };
  }, [closeProgress, provider.id, authType]);

  const handleLogin = useCallback(
    async (mutation: CredentialMutationOptions = {}) => {
      const attempt = loginAttemptRef.current + 1;
      loginAttemptRef.current = attempt;
      closeProgress();
      challengeRef.current = null;
      setLoginState({ phase: "connecting" });
      setInputValue("");

      try {
        // Do not race cancellation with startup: a late cancel would abort the
        // brand-new OAuth flow and make the Login button appear unresponsive.
        await call("auth.loginCancel", { provider: provider.id });
      } catch (error) {
        if (loginAttemptRef.current !== attempt) return;
        setLoginState({
          phase: "error",
          message: error instanceof Error ? error.message : t("modelUnableResetLogin", "Unable to reset login"),
        });
        return;
      }
      if (loginAttemptRef.current !== attempt) return;

      let startRequested = false;
      const acceptChallenge = (token: string) => {
        if (challengeRef.current !== token) setInputValue("");
        challengeRef.current = token;
      };
      const finishProgress = () => {
        loginAttemptRef.current += 1;
        challengeRef.current = null;
        closeProgress();
      };
      try {
        const unsubscribe = await subscribeAuthLogin(provider.id, (data: LoginProgressEvent) => {
          if (loginAttemptRef.current !== attempt || !startRequested) return;
          if (data.type === "auth") {
            acceptChallenge(data.token);
            setLoginState({ phase: "auth", url: data.url, instructions: data.instructions ?? null, token: data.token });
            // Single open path (ISSUE-008): prefer desktop openExternal
            if (data.url) {
              void (
                window.piBridge?.openExternal(data.url) ??
                Promise.resolve(window.open(data.url, "_blank", "noopener,noreferrer"))
              );
            }
          } else if (data.type === "device_code") {
            setLoginState({
              phase: "device_code",
              userCode: data.userCode,
              verificationUri: data.verificationUri,
              intervalSeconds: data.intervalSeconds ?? null,
              expiresInSeconds: data.expiresInSeconds ?? null,
            });
            if (data.verificationUri) {
              void (
                window.piBridge?.openExternal(data.verificationUri) ??
                Promise.resolve(window.open(data.verificationUri, "_blank", "noopener,noreferrer"))
              );
            }
          } else if (data.type === "prompt_request") {
            acceptChallenge(data.token);
            setLoginState({
              phase: "prompt",
              message: data.message,
              placeholder: data.placeholder ?? null,
              token: data.token,
              secret: data.secret,
            });
          } else if (data.type === "select_request") {
            acceptChallenge(data.token);
            setLoginState({ phase: "select", message: data.message, options: data.options ?? [], token: data.token });
          } else if (data.type === "progress") {
            setLoginState({ phase: "progress", message: data.message });
          } else if (data.type === "success") {
            finishProgress();
            setInputValue("");
            setLoginState({
              phase: "success",
              ...(data.warning ? { message: data.warning.message, warning: true } : {}),
            });
            onRefresh();
          } else if (data.type === "error") {
            finishProgress();
            setLoginState({ phase: "error", message: data.message });
            onReloadCredentials?.();
          } else if (data.type === "cancelled") {
            finishProgress();
            setLoginState({ phase: "idle" });
            onReloadCredentials?.();
          }
        });
        if (loginAttemptRef.current !== attempt) {
          unsubscribe();
          return;
        }
        progressUnsubRef.current = unsubscribe;
        startRequested = true;
        const result = await call("auth.loginStart", {
          provider: provider.id,
          ...(authType === "api_key" ? { authType } : {}),
          ...mutation,
        });
        if (loginAttemptRef.current !== attempt) return;
        if (!result.started) throw new Error("A login is already active. Cancel it and try again.");
      } catch (error) {
        if (loginAttemptRef.current !== attempt) return;
        finishProgress();
        setLoginState({
          phase: "error",
          message: error instanceof Error ? error.message : t("modelConnectionLost", "Connection lost"),
        });
      }
    },
    [closeProgress, provider.id, authType, onRefresh, onReloadCredentials, t],
  );

  const requestLogin = useCallback(() => {
    if (provider.storedAuthType && provider.storedAuthType !== authType) {
      setReplacement({ version: provider.credentialVersion });
      return;
    }
    void handleLogin(provider.credentialVersion ? { expectedVersion: provider.credentialVersion } : {});
  }, [provider.storedAuthType, provider.credentialVersion, authType, handleLogin]);

  const handleCancelLogin = useCallback(() => {
    loginAttemptRef.current += 1;
    closeProgress();
    challengeRef.current = null;
    setLoginState({ phase: "idle" });
    setInputValue("");
    void call("auth.loginCancel", { provider: provider.id }).catch(() => {});
    onReloadCredentials?.();
  }, [closeProgress, provider.id, onReloadCredentials]);

  const handleLogout = useCallback(async () => {
    try {
      const result = await call(authType === "oauth" ? "auth.logout" : "auth.deleteApiKey", {
        provider: provider.id,
        ...(provider.credentialVersion ? { expectedVersion: provider.credentialVersion } : {}),
      });
      setLoginState(
        result.warning
          ? { phase: "success", message: result.warning.message, warning: true }
          : { phase: "success", message: t("modelDisconnectedSuccessfully", "Disconnected successfully.") },
      );
      onRefresh();
    } catch (error) {
      setLoginState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      onReloadCredentials?.();
    }
  }, [provider.id, provider.credentialVersion, authType, onRefresh, onReloadCredentials, t]);

  const submitChallenge = useCallback(
    async (token: string, code: string, message: string, clearInput: boolean) => {
      const attempt = loginAttemptRef.current;
      if (
        challengeRef.current !== token ||
        (submissionRef.current?.attempt === attempt && submissionRef.current.token === token)
      )
        return;
      const submission = { attempt, token };
      submissionRef.current = submission;
      const current = () => loginAttemptRef.current === attempt && challengeRef.current === token;
      setLoginState({ phase: "progress", message });
      try {
        await call("auth.loginSubmit", { provider: provider.id, token, code });
        if (current() && clearInput) setInputValue("");
      } catch (error) {
        if (current())
          setLoginState({
            phase: "error",
            message: error instanceof Error ? error.message : t("modelNetworkError", "Network error"),
          });
      } finally {
        if (submissionRef.current === submission) submissionRef.current = null;
      }
    },
    [provider.id, t],
  );

  const submitCode = useCallback(
    (token: string, code: string) => {
      if (!code.trim()) return Promise.resolve();
      return submitChallenge(token, code.trim(), t("modelVerifying", "Verifying…"), true);
    },
    [submitChallenge, t],
  );

  const submitSelection = useCallback(
    (token: string, value: string) => {
      return submitChallenge(token, value, t("modelContinuing", "Continuing…"), false);
    },
    [submitChallenge, t],
  );

  const isWorking =
    loginState.phase === "connecting" ||
    loginState.phase === "progress" ||
    loginState.phase === "auth" ||
    loginState.phase === "device_code" ||
    loginState.phase === "prompt" ||
    loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>
          {authType === "oauth"
            ? t("modelSubscription", "Subscription")
            : t("modelGuidedLogin", "Guided API key setup")}
        </SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.loggedIn ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
            {authType === "api_key"
              ? provider.loggedIn
                ? t("modelCredentialsSaved", "Credentials saved")
                : t("modelCredentialsNotSaved", "No saved credentials")
              : provider.loggedIn
                ? t("modelConnected", "connected")
                : t("modelNotConnected", "not connected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {authType === "api_key"
              ? t("modelKeyWizardHelp", "Follow the steps to enter this provider’s key and account identifiers.")
              : provider.loggedIn
                ? t("modelAlreadyConnected", "Already connected. You can re-login or disconnect.")
                : t("modelConnectAccount", "Connect your {provider} account.").replace(
                    "{provider}",
                    oauthProviderName(provider.id, provider.name, t),
                  )}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            {authType === "oauth"
              ? t("modelOpeningBrowser", "Opening browser…")
              : t("modelStartingLogin", "Starting sign-in…")}
          </p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{
                    padding: "6px 9px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 12,
                    textAlign: "left",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? t(
                    "modelCompleteSignIn",
                    "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below.",
                  )
                : authPromptLabel(loginState.message, t)}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("modelBrowserDidNotOpen", "If the browser window did not open,")}{" "}
                <a
                  href={loginState.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", wordBreak: "break-all" }}
                >
                  {t("modelOpenLoginPage", "click here to open the login page")}
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type={loginState.phase === "prompt" && loginState.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode(loginState.token, inputValue);
                }}
                placeholder={
                  loginState.phase === "auth"
                    ? "http://localhost:1455/auth/callback?code=…"
                    : (loginState.placeholder ?? t("modelEnterValue", "Enter value…"))
                }
                style={{
                  flex: 1,
                  padding: "6px 9px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{
                  padding: "6px 12px",
                  background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 5,
                  color: inputValue.trim() ? "#fff" : "var(--text-dim)",
                  cursor: inputValue.trim() ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {t("submit", "Submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("modelOpenVerificationPage", "Open the verification page and enter this code:")}
            </p>
            <div
              style={{
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
                letterSpacing: 0,
              }}
            >
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a
                href={loginState.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", wordBreak: "break-all" }}
              >
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds
                ? ` ${t("modelCodeExpires", "Expires in {minutes} minutes.").replace(
                    "{minutes}",
                    String(Math.ceil(loginState.expiresInSeconds / 60)),
                  )}`
                : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: loginState.warning ? "#d97706" : "#4ade80" }}>
            {loginState.message ??
              (authType === "api_key"
                ? t("modelCredentialsSaved", "Credentials saved")
                : t("modelConnectedSuccessfully", "Connected successfully."))}
          </p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      {replacement && (
        <AuthReplacementNotice
          onCancel={() => setReplacement(null)}
          onConfirm={() => {
            const mutation = {
              replaceExisting: true,
              ...(replacement.version ? { expectedVersion: replacement.version } : {}),
            };
            setReplacement(null);
            void handleLogin(mutation);
          }}
        />
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={handleCancelLogin}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("cancel", "Cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={requestLogin}
              style={{
                padding: "5px 14px",
                background: "var(--accent)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {authType === "api_key"
                ? t("modelConfigureCredentials", "Configure credentials")
                : provider.loggedIn
                  ? t("modelRelogin", "Re-login")
                  : t("modelLogin", "Login")}
            </button>
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{
                  padding: "5px 12px",
                  background: "none",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 5,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {t("modelDisconnect", "Disconnect")}
              </button>
            )}
          </>
        )}
      </div>

      {provider.loggedIn && <ManagedModelsControl providerId={provider.id} {...modelSelection} />}
    </div>
  );
}
