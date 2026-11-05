
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "demo": {
          Tables: {
            "company": {
                  Row: {
                    "id": string,"org_id": string,"title_txt": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id": string,"org_id": string,"title_txt": string
                  }
                  Update: {
                    "id"?: string,"org_id"?: string,"title_txt"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"contact": {
                  Row: {
                    "company_id": string | null,"deletion_mark": boolean,"email_addr": string | null,"full_nm": string,"id": string,"org_id": string,"referrer_id": string | null,"row_ver": number,"score": number | null,"score_num": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id"?: string | null,"deletion_mark"?: boolean,"email_addr"?: string | null,"full_nm": string,"id": string,"org_id": string,"referrer_id"?: string | null,"row_ver"?: number,"score"?: number | null,"score_num"?: number | null
                  }
                  Update: {
                    "company_id"?: string | null,"deletion_mark"?: boolean,"email_addr"?: string | null,"full_nm"?: string,"id"?: string,"org_id"?: string,"referrer_id"?: string | null,"row_ver"?: number,"score"?: number | null,"score_num"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "contact_company_fk"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_referrer_fk"
      columns: ["referrer_id"]
isOneToOne: false
      referencedRelation: "company"
      referencedColumns: ["id"]
    }
                  ]
                },"legacy_note": {
                  Row: {
                    "body": string,"id": string,"org_id": string,"prio": number | null,"prio_num": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"id"?: string,"org_id": string,"prio"?: number | null,"prio_num"?: number | null
                  }
                  Update: {
                    "body"?: string,"id"?: string,"org_id"?: string,"prio"?: number | null,"prio_num"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "legacy_note_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"member": {
                  Row: {
                    "org_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"user_id": string
                  }
                  Update: {
                    "org_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "member_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "org"
      referencedColumns: ["id"]
    }
                  ]
                },"org": {
                  Row: {
                    "id": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id": string,"title": string
                  }
                  Update: {
                    "id"?: string,"title"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "contact_save":
{ Args: { "p_expected_version": number,"p_item": Json }; Returns: string
                           },
"p0d_trace":
{ Args: { "p_label": string,"p_score": string,"p_score_num": string }; Returns: undefined
                           },
"user_scopes":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            "legacy_note_key": {
                        "id": string | null,"org_id": string | null
                      }
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "demo">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "demo": {
          Enums: {
            
          }
        }
} as const
