export const GET_SHOP_QUERY = `#graphql
  query GetShop {
    shop {
      id
      name
      myshopifyDomain
      email
      currencyCode
      primaryDomain {
        url
        host
      }
    }
  }
`;
export const GET_ORDERS_QUERY = `#graphql
  query GetOrders($first: Int = 20, $query: String) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
      pageInfo {
        hasNextPage
        hasPreviousPage
      }
      edges {
        node {
          id
          name
          email
          phone
          createdAt
          cancelledAt
          cancelReason
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          customer {
            id
            firstName
            lastName
            displayName
            email
            phone
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          shippingAddress {
            address1
            address2
            city
            province
            country
            zip
            firstName
            lastName
            phone
            formatted
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                currentQuantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                image {
                  url
                  altText
                }
                variant {
                  id
                  title
                  sku
                  price
                  availableForSale
                  image {
                    url
                    altText
                  }
                  product {
                    id
                    title
                    handle
                    featuredImage {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_ORDER_QUERY = `#graphql
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      phone
      createdAt
      cancelledAt
      cancelReason
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      paymentCollectionDetails {
        additionalPaymentCollectionUrl
      }
      shippingAddress {
        address1
        address2
        city
        province
        country
        zip
        firstName
        lastName
        phone
      }
      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            currentQuantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            variant {
              id
              title
              price
              availableForSale
              product {
                id
                title
                handle
                featuredImage {
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_PRODUCT_VARIANTS_QUERY = `#graphql
  query GetProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      variants(first: 50) {
        edges {
          node {
            id
            title
            price
            availableForSale
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

export const GET_ORDER_TRANSACTIONS_QUERY = `#graphql
  query GetOrderTransactions($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalReceivedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalOutstandingSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      paymentCollectionDetails {
        additionalPaymentCollectionUrl
      }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        formattedGateway
        test
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        parentTransaction {
          id
        }
      }
    }
  }
`;

export const ORDER_EDIT_BEGIN_MUTATION = `#graphql
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              variant {
                id
                title
                product {
                  id
                  title
                }
              }
            }
          }
        }
        addedLineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              variant {
                id
                title
                product {
                  id
                  title
                }
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_EDIT_SET_QUANTITY_MUTATION = `#graphql
  mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
      calculatedOrder {
        id
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
        addedLineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
      }
      calculatedLineItem {
        id
        quantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_EDIT_ADD_VARIANT_MUTATION = `#graphql
  mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
      calculatedOrder {
        id
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
        addedLineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
      }
      calculatedLineItem {
        id
        quantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_EDIT_COMMIT_MUTATION = `#graphql
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order {
        id
        name
        displayFinancialStatus
        displayFulfillmentStatus
        paymentCollectionDetails {
          additionalPaymentCollectionUrl
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const REFUND_CREATE_MUTATION = `#graphql
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        createdAt
        note
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        transactions(first: 10) {
          id
          status
          kind
          gateway
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation OrderInvoiceSend($id: ID!, $email: EmailInput) {
    orderInvoiceSend(id: $id, email: $email) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_UPDATE_MUTATION = `#graphql
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        name
        shippingAddress {
          address1
          address2
          city
          province
          country
          zip
          firstName
          lastName
          phone
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_CANCEL_MUTATION = `#graphql
  mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
    orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
        code
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SET_METAFIELDS_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;


