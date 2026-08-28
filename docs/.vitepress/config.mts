import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'PCS7 Matrix Generator',
  description: 'User manual for the PCS7 Matrix Generator',
  cleanUrls: true,

  themeConfig: {
    search: {
      provider: 'local',
    },

    nav: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Guide', link: '/guide/projects' },
      { text: 'FAQ', link: '/troubleshooting' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [{ text: 'Getting Started', link: '/getting-started' }],
      },
      {
        text: 'Workflow',
        items: [
          { text: '1. Projects', link: '/guide/projects' },
          { text: '2. IO Import', link: '/guide/io-import' },
          { text: '3. EPH/EM Import', link: '/guide/eph-em-import' },
          { text: '4. Library', link: '/guide/library' },
          { text: '5. Unit Types', link: '/guide/unit-types' },
          { text: '6. Hierarchy', link: '/guide/hierarchy' },
          { text: '7. Instances', link: '/guide/instances' },
          { text: '8. HW Config', link: '/guide/hw-config' },
          { text: '9. Generate', link: '/guide/generate' },
        ],
      },
      {
        text: 'Help',
        items: [{ text: 'Troubleshooting / FAQ', link: '/troubleshooting' }],
      },
    ],

    socialLinks: [],

    footer: {
      message: 'PCS7 Matrix Generator — internal user manual',
    },
  },
})
