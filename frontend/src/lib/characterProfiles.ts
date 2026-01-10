export type CharacterProfile = {
  id: string
  name: string
  handle: string
  title: string
  location?: string
  bio: string
  motto: string
  image: string
}

export const CHARACTER_PROFILES: CharacterProfile[] = [
  {
    id: 'ayaka',
    name: 'Ayaka（彩香）',
    handle: '@ayaka',
    title: '資産数十億の個人投資家／リスク管理至上主義',
    location: 'アメリカ在住',
    bio: '20代前半で借金と失職 → XMでFXを独学 → 初期は連敗と破産寸前 → 取引記録と資金管理で再起 → 数年かけて資産十億以上へ',
    motto: '「勝つより生き残れ」「期待値と規律がすべて」\n「感情は損切りの敵」「派手さより再現性」',
    image: '/media/ayaka.png',
  },
]
