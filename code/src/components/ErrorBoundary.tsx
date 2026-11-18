import React from 'react';
import { t } from '../i18n';
import type { InterfaceLang } from '../types';
import { PRIVACY_CONTACT } from '../content/privacyPolicy';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  resetKey?: string;
  interfaceLang?: InterfaceLang;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('View render failed:', error, info);
  }

  render() {
    if (this.state.error) {
      const lang = this.props.interfaceLang || 'ru';
      return (
        <div className="card max-w-xl mx-auto min-h-[180px] flex flex-col items-center justify-center gap-3 text-center p-6">
          <h2 className="text-lg font-bold text-[var(--text)]">{t('error.title', lang)}</h2>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            {t('error.subtitle', lang)}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className="btn primary"
              onClick={() => window.location.reload()}
            >
              {t('error.reload', lang)}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                window.location.hash = '';
                window.location.reload();
              }}
            >
              {t('error.go_home', lang)}
            </button>
            <a href={`mailto:${PRIVACY_CONTACT}`} className="btn text-caption">
              {t('footer.feedback', lang)}
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
