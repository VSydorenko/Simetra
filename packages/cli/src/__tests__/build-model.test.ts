import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { buildProjectModel } from '../build-model'

const TMP_DIR = join(import.meta.dirname, '__tmp_build_model_test__')

function setupTmpDir() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
}

function cleanupTmpDir() {
  rmSync(TMP_DIR, { recursive: true, force: true })
}

describe('buildProjectModel', () => {
  it('парсить валідну директорію з project.meta.json', () => {
    setupTmpDir()
    try {
      const project = {
        name: 'TestProject',
        version: '1.0.0',
        description: { uk: 'Тест', en: 'Test' },
      }
      writeFileSync(
        join(TMP_DIR, 'project.meta.json'),
        JSON.stringify(project),
      )

      const model = buildProjectModel(TMP_DIR)
      expect(model.project.name).toBe('TestProject')
      expect(model.catalogs).toEqual([])
      expect(model.documents).toEqual([])
      expect(model.enumerations).toEqual([])
    } finally {
      cleanupTmpDir()
    }
  })

  it('кидає помилку при відсутності project.meta.json', () => {
    setupTmpDir()
    try {
      expect(() => buildProjectModel(TMP_DIR)).toThrow(
        /project\.meta\.json не знайдено/,
      )
    } finally {
      cleanupTmpDir()
    }
  })

  it('кидає помилку при невалідному JSON', () => {
    setupTmpDir()
    try {
      writeFileSync(
        join(TMP_DIR, 'project.meta.json'),
        '{ invalid json',
      )
      expect(() => buildProjectModel(TMP_DIR)).toThrow(
        /project\.meta\.json/,
      )
    } finally {
      cleanupTmpDir()
    }
  })
})
