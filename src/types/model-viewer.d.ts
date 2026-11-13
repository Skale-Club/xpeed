import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string; alt?: string; poster?: string; loading?: string; reveal?: string;
        'camera-controls'?: string; 'disable-pan'?: string; 'touch-action'?: string;
        'interaction-prompt'?: string;
        'camera-orbit'?: string; 'shadow-intensity'?: string;
      };
    }
  }
}
