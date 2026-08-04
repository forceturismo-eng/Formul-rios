# @forms/ui

Design system. Entra na **Fase 2**, junto com o app web.

Um requisito molda o pacote desde já: todo componente precisa aceitar o
branding da organização (cor primária, logo, fonte) sem `!important` e sem CSS
global. Nos planos Pro e acima, o formulário público sai com o visual do
cliente e sem a marca do produto — se o design system assumir cores fixas,
white-label vira gambiarra.

O CSS customizado dos planos Business+ é sanitizado antes de renderizar: sem
`<script>`, sem `url()` externo arbitrário.
