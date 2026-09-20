<template>
  <div class="user-list">
    <UserRow v-for="u in users" :key="u.id" :user="u" @select="onSelect" />
    <button :disabled="loading" @click="onSubmit">提交</button>
    <p>{{ total }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import UserRow from './UserRow.vue'
import { MnsClient } from './mns-client'

interface Props {
  accountId: string
  pageSize?: number
}
const props = withDefaults(defineProps<Props>(), { pageSize: 20 })

const users = ref<Array<{ id: string }>>([])
const loading = ref(false)
const total = computed(() => users.value.length)

async function onSubmit() {
  loading.value = true
  const client = new MnsClient(props.accountId, 'k')
  await client.sendMessage('q', 'hi')
  loading.value = false
}

function onSelect(id: string) {
  users.value = users.value.filter((u) => u.id !== id)
}

onMounted(() => {
  users.value = [{ id: '1' }]
})
</script>

<style scoped>
.user-list {
  padding: 8px;
}
</style>
