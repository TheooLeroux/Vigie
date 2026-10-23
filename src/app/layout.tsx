import type { Metadata } from "next";
import "./globals.css";
import "./theme.css";
import "./workspace.css";
import "../components/maintenance.css";
export const metadata:Metadata={title:"Vigie — Votre parc web, au même endroit",description:"Inventaire interne des sites, services, environnements et accès."};
export default function RootLayout({children}:{children:React.ReactNode}){
  return (
    <html lang="fr" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html: `try{document.documentElement.dataset.theme=localStorage.getItem("vigie-theme")==="light"?"light":"dark"}catch{}`}} />
      </head>
      <body>{children}</body>
    </html>
  );
}
